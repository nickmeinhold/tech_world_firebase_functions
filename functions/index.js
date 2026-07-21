/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const functions = require("firebase-functions");
const {onCall, HttpsError} = require("firebase-functions/v2/https");

// Firebase Admin SDK — initializeApp required for Cloud Functions runtime.
const admin = require("firebase-admin");
admin.initializeApp();

/**
 * Validate that required LiveKit env vars are set.
 * @return {{key: string, secret: string}}
 */
function requireLiveKitEnv() {
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!key || !secret) {
    throw new HttpsError("internal",
        "Server misconfigured: missing LiveKit credentials");
  }
  return {key, secret};
}

/**
 * Callable function to retrieve a LiveKit token for the authenticated user.
 * Called by the Flutter client when connecting to a room.
 */
exports.retrieveLiveKitToken = onCall(async (request) => {
  // Ensure user is authenticated
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const roomName = request.data.roomName;
  if (!roomName || typeof roomName !== "string") {
    throw new HttpsError("invalid-argument", "roomName is required");
  }

  const {key, secret} = requireLiveKitEnv();

  const {
    AccessToken,
    RoomAgentDispatch,
    RoomConfiguration,
  } = await import("livekit-server-sdk");

  const userName = request.auth.token.name ||
                   request.auth.token.email ||
                   "Guest";

  const at = new AccessToken(key, secret, {
    identity: request.auth.uid,
    name: userName,
    ttl: "1h",
  });

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  });

  // Dispatch bot agents when this user joins the room.
  at.roomConfig = new RoomConfiguration({
    agents: [
      new RoomAgentDispatch({agentName: "clawd"}),
      new RoomAgentDispatch({agentName: "gremlin"}),
      new RoomAgentDispatch({agentName: "dreamfinder"}),
    ],
  });

  const token = await at.toJwt();
  functions.logger.info(
      `Token generated for user ${request.auth.uid} in room ${roomName}`,
  );

  return token;
});

/**
 * Callable function to retrieve a LiveKit token for a bot service.
 * Supports both Clawd and Gremlin bots via the `botName` parameter.
 */
const BOT_IDENTITIES = {
  clawd: {identity: "bot-claude", name: "Clawd"},
  gremlin: {identity: "bot-gremlin", name: "Gremlin"},
};

/**
 * One-shot DM backfill — populates `participants: [uid1, uid2]` on legacy
 * chat messages that predate the participants-array schema.
 *
 * Required because firestore.rules now demand `participants` on every DM read;
 * messages without it become unreadable. Run this BEFORE deploying the rules
 * change, or in the same window.
 *
 * Auth: gated on BACKFILL_SECRET env var (mirrors getBotToken pattern). Set
 * the secret on the deployed function, invoke once, then unset.
 *
 * Parse: `conversationId` for DMs is `dm_<uid1>_<uid2>` where UIDs are
 * sorted alphabetically (see lib/chat/conversation.dart:65). Firebase Auth
 * UIDs are 28-char alphanumeric — no underscores — so `split('_')` yields
 * exactly 3 parts. Anything else is skipped + logged.
 *
 * Idempotent: skips docs that already have `participants`. Skips group
 * messages (conversationId === 'group') — the rule allows those without
 * participants.
 *
 * Returns: {processed, updated, alreadySet, group, malformed, errors}.
 */
exports.backfillDmParticipants = onCall(
    {timeoutSeconds: 540, memory: "512MiB"},
    async (request) => {
      const crypto = require("crypto");
      const expected = process.env.BACKFILL_SECRET;
      const provided = request.data && request.data.backfillSecret;
      if (!expected || !provided || typeof provided !== "string") {
        throw new HttpsError("permission-denied",
            "Invalid backfill credentials");
      }
      const expectedHash = crypto.createHash("sha256")
          .update(expected).digest();
      const providedHash = crypto.createHash("sha256")
          .update(provided).digest();
      if (!crypto.timingSafeEqual(expectedHash, providedHash)) {
        throw new HttpsError("permission-denied",
            "Invalid backfill credentials");
      }

      const dryRun = request.data && request.data.dryRun === true;
      const db = admin.firestore();
      const counts = {
        processed: 0,
        updated: 0,
        alreadySet: 0,
        group: 0,
        malformed: 0,
        errors: 0,
      };

      // collectionGroup scans every `messages` subcollection across all rooms.
      const snapshot = await db.collectionGroup("messages").get();
      functions.logger.info(
          `Backfill scanning ${snapshot.size} message docs (dryRun=${dryRun})`,
      );

      let batch = db.batch();
      let batchSize = 0;
      const FLUSH_AT = 450; // Firestore limit is 500; leave headroom.

      for (const doc of snapshot.docs) {
        counts.processed++;
        const data = doc.data();

        if (Array.isArray(data.participants) && data.participants.length > 0) {
          counts.alreadySet++;
          continue;
        }
        if (data.conversationId === "group") {
          counts.group++;
          continue;
        }
        if (typeof data.conversationId !== "string") {
          counts.malformed++;
          functions.logger.warn(
              `Skipping ${doc.ref.path}: conversationId not a string`);
          continue;
        }

        // Expected: dm_<uid1>_<uid2>
        const parts = data.conversationId.split("_");
        if (parts.length !== 3 || parts[0] !== "dm" ||
            !parts[1] || !parts[2]) {
          counts.malformed++;
          functions.logger.warn(
              `Skipping ${doc.ref.path}: ` +
              `conversationId="${data.conversationId}" not parseable`);
          continue;
        }

        const participants = [parts[1], parts[2]];
        if (dryRun) {
          counts.updated++;
          continue;
        }

        batch.update(doc.ref, {participants});
        batchSize++;
        if (batchSize >= FLUSH_AT) {
          try {
            await batch.commit();
            counts.updated += batchSize;
          } catch (err) {
            counts.errors += batchSize;
            functions.logger.error(`Batch commit failed: ${err.message}`);
          }
          batch = db.batch();
          batchSize = 0;
        }
      }

      if (batchSize > 0 && !dryRun) {
        try {
          await batch.commit();
          counts.updated += batchSize;
        } catch (err) {
          counts.errors += batchSize;
          functions.logger.error(`Final batch commit failed: ${err.message}`);
        }
      }

      functions.logger.info(`Backfill complete: ${JSON.stringify(counts)}`);
      return counts;
    },
);

exports.getBotToken = onCall(async (request) => {
  // Verify request contains bot secret using timing-safe comparison.
  // Guards against: (1) undefined BOT_SECRET env var, (2) timing attacks.
  const crypto = require("crypto");
  const expected = process.env.BOT_SECRET;
  const provided = request.data.botSecret;
  if (!expected || !provided || typeof provided !== "string") {
    throw new HttpsError("permission-denied", "Invalid bot credentials");
  }
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  const providedHash = crypto.createHash("sha256").update(provided).digest();
  if (!crypto.timingSafeEqual(expectedHash, providedHash)) {
    throw new HttpsError("permission-denied", "Invalid bot credentials");
  }

  const roomName = request.data.roomName;
  if (!roomName || typeof roomName !== "string") {
    throw new HttpsError("invalid-argument", "roomName is required");
  }

  const botName = request.data.botName || "clawd";
  const bot = BOT_IDENTITIES[botName];
  if (!bot) {
    const valid = Object.keys(BOT_IDENTITIES).join(", ");
    throw new HttpsError("invalid-argument",
        `Unknown bot "${botName}". Valid: ${valid}`);
  }

  const {key, secret} = requireLiveKitEnv();
  const {AccessToken} = await import("livekit-server-sdk");

  const at = new AccessToken(key, secret, {
    identity: bot.identity,
    name: bot.name,
    ttl: "24h", // Bot stays connected longer
  });

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  });

  const token = await at.toJwt();
  functions.logger.info(
      `Bot token generated for ${bot.name} in room ${roomName}`,
  );
  return token;
});


