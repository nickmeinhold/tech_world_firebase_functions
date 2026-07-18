/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const functions = require("firebase-functions");
const {onCall, onRequest, HttpsError} =
    require("firebase-functions/v2/https");

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

/**
 * Identities that never write a `/presence` document — the bots dispatched
 * into every room (see `retrieveLiveKitToken`). A `participant_left` for one of
 * these is a no-op, so we skip the Firestore round trip entirely.
 * @param {string} identity Participant identity from the webhook event.
 * @return {boolean} True for bot/agent identities.
 */
function isServiceIdentity(identity) {
  return identity.startsWith("bot-") || identity.startsWith("agent-");
}

/**
 * LiveKit webhook endpoint driving presence-ghost cleanup.
 *
 * The Flutter client writes `/presence/{userId}` on connect and deletes it on a
 * *graceful* leave (`RoomSession.leave`). An ungraceful disconnect — tab close,
 * crash, network drop — leaves a ghost document, because Firestore has no
 * `onDisconnect` hook (unlike Realtime Database). LiveKit is the real source of
 * truth for connection state, so its `participant_left` / `room_finished`
 * webhooks are the authoritative cure (tech_world issue #1361).
 *
 * Security: every request is authenticated with `WebhookReceiver`, which
 * verifies the LiveKit-signed JWT in the `Authorization` header against the raw
 * request body. We fail closed — a missing header, a bad signature, or an
 * unparseable body returns 4xx and no Firestore mutation happens.
 *
 * Once verified, processing errors still return 200: LiveKit retries non-2xx
 * responses, and deletes here are idempotent (a missed one self-heals on the
 * next event), so a transient Firestore hiccup must not trigger a retry storm.
 */
exports.livekitWebhook = onRequest(async (req, res) => {
  const {key, secret} = (() => {
    const k = process.env.LIVEKIT_API_KEY;
    const s = process.env.LIVEKIT_API_SECRET;
    if (!k || !s) {
      functions.logger.error("livekitWebhook: missing LiveKit credentials");
      return {key: null, secret: null};
    }
    return {key: k, secret: s};
  })();
  if (!key || !secret) {
    // Misconfiguration, not an attacker: 500 so LiveKit retries once creds
    // are set, rather than silently swallowing real events.
    res.status(500).send("Server misconfigured");
    return;
  }

  const authHeader = req.get("Authorization");
  if (!authHeader) {
    functions.logger.warn("livekitWebhook: missing Authorization header");
    res.status(401).send("Unauthorized");
    return;
  }

  const {WebhookReceiver} = await import("livekit-server-sdk");
  const receiver = new WebhookReceiver(key, secret);

  let event;
  try {
    // `rawBody` (Buffer) is required: WebhookReceiver re-hashes the exact bytes
    // LiveKit signed. A re-serialized `req.body` would not match the signature.
    event = await receiver.receive(req.rawBody.toString(), authHeader);
  } catch (err) {
    functions.logger.warn(
        `livekitWebhook: signature verification failed: ${err}`,
    );
    res.status(401).send("Unauthorized");
    return;
  }

  try {
    const db = admin.firestore();

    switch (event.event) {
      case "participant_left": {
        const identity = event.participant && event.participant.identity;
        const roomName = event.room && event.room.name;
        if (!identity || !roomName) break;
        if (isServiceIdentity(identity)) break;

        // Conditional delete: the user may have already moved to another room,
        // in which case their presence doc now points at the *new* room. A late
        // `participant_left` from the old room must not delete that fresh
        // presence. The transaction reads-then-deletes atomically so a
        // concurrent `enter` write can't slip between the check and the delete.
        const ref = db.collection("presence").doc(identity);
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists) return;
          if (snap.get("currentRoomId") !== roomName) return;
          tx.delete(ref);
        });
        functions.logger.info(
            `livekitWebhook: cleaned presence for ${identity} ` +
            `leaving ${roomName}`,
        );
        break;
      }

      case "room_finished": {
        const roomName = event.room && event.room.name;
        if (!roomName) break;

        // The room emptied and LiveKit tore it down: reap every presence doc
        // still pointing at it. Batched delete keeps this a single round trip.
        // TODO(#1706): this is where clear-group-chat-on-empty will hook in —
        // retention semantics (delete vs archive vs keep) are still undecided,
        // so chat deletion is intentionally NOT implemented here yet.
        const stale = await db.collection("presence")
            .where("currentRoomId", "==", roomName)
            .get();
        if (!stale.empty) {
          const batch = db.batch();
          stale.docs.forEach((doc) => batch.delete(doc.ref));
          await batch.commit();
        }
        functions.logger.info(
            `livekitWebhook: room_finished reaped ${stale.size} ` +
            `presence doc(s) for ${roomName}`,
        );
        break;
      }

      default:
        // Ignore every other event type. Returning 200 (below) stops LiveKit
        // from retrying events we don't act on.
        break;
    }
  } catch (err) {
    // Verification already passed — this is a Firestore-side hiccup. Log and
    // still return 200: deletes are idempotent and self-heal on the next
    // event, so retries would only hammer without helping.
    functions.logger.error(`livekitWebhook: processing error: ${err}`);
  }

  res.status(200).send("OK");
});


