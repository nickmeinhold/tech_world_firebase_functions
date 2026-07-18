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
 * Whether `identity` is safe to use verbatim as a `/presence` document id.
 *
 * The identity is attacker-influenceable in principle (it is whatever the
 * signed token minted), so validate it before building a Firestore path:
 * a "/" would address a subcollection, "." / ".." are reserved, and Firestore
 * caps document ids at 1500 bytes. A pathological value is skipped (logged),
 * not thrown — a single bad event must not fall into the catch-all.
 * @param {*} identity Candidate identity from the webhook event.
 * @return {boolean} True when usable as a document id.
 */
function isValidPresenceIdentity(identity) {
  if (typeof identity !== "string" || identity.length === 0) return false;
  if (identity === "." || identity === "..") return false;
  if (identity.includes("/")) return false;
  if (Buffer.byteLength(identity, "utf8") > 1500) return false;
  return true;
}

/**
 * Decide whether a presence snapshot should be reaped for a room event.
 *
 * Two independent staleness axes, both checked inside the caller's transaction:
 *  - Room match: the doc must still point at the event's room. A user who moved
 *    rooms has re-pointed `currentRoomId`, so a late event from the room they
 *    left must not reap their new presence.
 *  - Freshness watermark: room names are stable Firestore doc ids, so LiveKit
 *    rooms reincarnate under the same name. A late `participant_left` (or a
 *    `room_finished` racing a fresh join) can match the room yet describe an
 *    OLDER session. We reap only when the presence write predates the event —
 *    `lastSeen < event.createdAt`. Both are server-authoritative clocks
 *    (Firestore server timestamp vs LiveKit server clock); we assume their skew
 *    is far smaller than the human gap between leaving and rejoining a room,
 *    which is the only interval this guard needs to resolve.
 *
 * Fail OPEN on missing signal: if `createdAtMs` is 0 (event carried no
 * `createdAt`) or `lastSeen` is missing/non-Timestamp, fall back to the
 * room-match-only decision rather than never cleaning — a surviving ghost is
 * worse than the rare misreap the watermark exists to prevent, and the room
 * guard already scopes the blast radius.
 * @param {FirebaseFirestore.DocumentSnapshot} snap Presence doc snapshot.
 * @param {string} roomName Event's room name.
 * @param {number} createdAtMs Event `createdAt` in ms, or 0 if unknown.
 * @return {boolean} True if the doc should be deleted.
 */
function shouldReapPresence(snap, roomName, createdAtMs) {
  if (!snap.exists) return false;
  if (snap.get("currentRoomId") !== roomName) return false;
  if (!createdAtMs) return true; // no watermark — room match suffices
  const lastSeen = snap.get("lastSeen");
  if (!lastSeen || typeof lastSeen.toMillis !== "function") return true;
  return lastSeen.toMillis() < createdAtMs;
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
 * unparseable body returns 4xx and no Firestore mutation happens. A missing
 * `rawBody` is a platform misconfiguration (500), a distinct failure from a
 * bad signature (401) — the two must not share a status code.
 *
 * Once verified, processing errors still return 200: LiveKit retries non-2xx
 * responses, and deletes here are idempotent (a missed one self-heals on the
 * next event), so a transient Firestore hiccup must not trigger a retry storm.
 */
exports.livekitWebhook = onRequest(async (req, res) => {
  // Webhooks are POSTs; reject anything else before doing any work.
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!key || !secret) {
    // Misconfiguration, not an attacker: 500 so LiveKit retries once creds
    // are set, rather than silently swallowing real events.
    functions.logger.error("livekitWebhook: missing LiveKit credentials");
    res.status(500).send("Server misconfigured");
    return;
  }

  const authHeader = req.get("Authorization");
  if (!authHeader) {
    functions.logger.warn("livekitWebhook: missing Authorization header");
    res.status(401).send("Unauthorized");
    return;
  }

  // `rawBody` (the exact bytes LiveKit signed) is what the receiver re-hashes.
  // Its absence is a runtime/platform fault, not a bad signature — 500 (retry),
  // NOT 401, so the two failure modes stay distinguishable in logs and retries.
  if (!Buffer.isBuffer(req.rawBody)) {
    functions.logger.error("livekitWebhook: rawBody missing or not a Buffer");
    res.status(500).send("Server misconfigured");
    return;
  }

  const {WebhookReceiver} = await import("livekit-server-sdk");
  const receiver = new WebhookReceiver(key, secret);

  let event;
  try {
    // A re-serialized `req.body` would not match the signature — use rawBody.
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

    // `createdAt` is protobuf int64 seconds (a JS bigint), the moment LiveKit
    // fired the event. 0/absent → watermark disabled downstream (fail open).
    const createdAtMs = event.createdAt ? Number(event.createdAt) * 1000 : 0;

    switch (event.event) {
      case "participant_left": {
        const identity = event.participant && event.participant.identity;
        const roomName = event.room && event.room.name;
        if (!identity || !roomName) break;
        if (isServiceIdentity(identity)) break;
        if (!isValidPresenceIdentity(identity)) {
          functions.logger.warn(
              `livekitWebhook: skipping pathological identity "${identity}"`,
          );
          break;
        }

        // Reap the user's presence doc only if it still points at this room
        // AND predates the event (see shouldReapPresence). The transaction
        // reads and deletes atomically so a concurrent `enter` (a rejoin)
        // can't slip between the guard and the delete.
        const ref = db.collection("presence").doc(identity);
        const deleted = await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (!shouldReapPresence(snap, roomName, createdAtMs)) return false;
          tx.delete(ref);
          return true;
        });
        if (deleted) {
          functions.logger.info(
              `livekitWebhook: cleaned presence for ${identity} ` +
              `leaving ${roomName}`,
          );
        } else {
          functions.logger.debug(
              `livekitWebhook: participant_left for ${identity} — presence ` +
              `not reaped (moved rooms, fresher session, or already gone)`,
          );
        }
        break;
      }

      case "room_finished": {
        const roomName = event.room && event.room.name;
        if (!roomName) break;

        // The room emptied and LiveKit tore it down: reap every presence doc
        // still pointing at it. Per-doc transactions (not one blind batch) so
        // each delete re-checks the room match AND freshness watermark at
        // commit time — a fresh join under the reincarnated room name must
        // survive — and so there is no 500-write batch cap. Room sizes are
        // small (tens), so sequential transactions are cheap.
        // TODO(#1706): this is where clear-group-chat-on-empty will hook in —
        // retention semantics (delete vs archive vs keep) are still undecided,
        // so chat deletion is intentionally NOT implemented here yet.
        const stale = await db.collection("presence")
            .where("currentRoomId", "==", roomName)
            .get();
        let reaped = 0;
        for (const doc of stale.docs) {
          const ref = doc.ref;
          const deleted = await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (!shouldReapPresence(snap, roomName, createdAtMs)) return false;
            tx.delete(ref);
            return true;
          });
          if (deleted) reaped++;
        }
        functions.logger.info(
            `livekitWebhook: room_finished reaped ${reaped} ` +
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


