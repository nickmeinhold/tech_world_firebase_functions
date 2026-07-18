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

// Watermark validity band. Reject a createdAt outside a sane epoch window so a
// seconds-vs-milliseconds unit drift in a future SDK can neither silently
// disable the watermark (absurdly small value) nor future-pin it (absurdly
// large value) — either way we fall back to the logged room-match-only path.
const MIN_VALID_EVENT_MS = Date.UTC(2020, 0, 1);
const CLOCK_TOLERANCE_MS = 24 * 60 * 60 * 1000; // 24h future tolerance

// Clock-skew margin for the freshness comparison. LiveKit's clock running
// ahead of Firestore's must not make an innocent fast rejoin look older than
// the event. Ghosts are minutes old, so 10s of slack costs nothing and never
// misreaps a live doc.
const SKEW_BUDGET_MS = 10000;

/**
 * Convert a WebhookEvent `createdAt` (protobuf int64 seconds, a JS bigint) to
 * epoch milliseconds, returning 0 — the "watermark disabled" sentinel — for
 * anything absent or implausible. An invalid value is logged distinctly so the
 * fail-open is observable, never silent.
 * @param {*} createdAt Raw `event.createdAt` (bigint | number | undefined).
 * @return {number} Epoch ms, or 0 if absent/invalid.
 */
function eventCreatedAtMs(createdAt) {
  if (!createdAt) return 0; // absent or zero — no watermark to apply
  const ms = Number(createdAt) * 1000;
  if (!Number.isFinite(ms) || ms <= 0 ||
      ms < MIN_VALID_EVENT_MS || ms > Date.now() + CLOCK_TOLERANCE_MS) {
    functions.logger.warn(
        `livekitWebhook: watermark disabled: invalid createdAt ${createdAt}`,
    );
    return 0;
  }
  return ms;
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
 *    OLDER session. We reap only when the presence write predates the event by
 *    more than a skew margin — `lastSeen < event.createdAt - SKEW_BUDGET_MS`.
 *    Both are server-authoritative clocks (Firestore server timestamp vs
 *    LiveKit server clock); the margin absorbs a LiveKit-clock-ahead skew so an
 *    innocent fast rejoin isn't mistaken for an older session. The interval
 *    this guard resolves — the human gap between leaving and rejoining — dwarfs
 *    both the skew and the margin.
 *
 * Two different failure directions on missing signal, deliberately:
 *  - No event watermark (`createdAtMs === 0`): fail OPEN — fall back to the
 *    room-match-only decision rather than never cleaning. A surviving ghost is
 *    worse than a rare misreap, and the room guard still scopes the reap.
 *  - Event HAS a watermark but `lastSeen` is missing/non-Timestamp: fail
 *    CLOSED (do not reap). `PresenceService.enter` always writes a
 *    serverTimestamp `lastSeen`, so with a valid watermark a missing one is a
 *    malformed doc or a programmer omission, not legacy state — the
 *    "ghost beats misreap" tradeoff must not silently absorb that.
 * @param {FirebaseFirestore.DocumentSnapshot} snap Presence doc snapshot.
 * @param {string} roomName Event's room name.
 * @param {number} createdAtMs Event `createdAt` in ms, or 0 if unknown.
 * @return {boolean} True if the doc should be deleted.
 */
function shouldReapPresence(snap, roomName, createdAtMs) {
  if (!snap.exists) return false;
  if (snap.get("currentRoomId") !== roomName) return false;
  if (!createdAtMs) return true; // no event watermark — room match suffices
  const lastSeen = snap.get("lastSeen");
  if (!lastSeen || typeof lastSeen.toMillis !== "function") return false;
  return lastSeen.toMillis() < createdAtMs - SKEW_BUDGET_MS;
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
 * Response contract after verification is per-handler:
 *  - `participant_left`: always 200, even on a processing error. The next
 *    lifecycle event self-heals a missed delete, so redelivery buys nothing and
 *    a retry storm is the only downside.
 *  - `room_finished`: 200 when the sweep completes clean (or has nothing to
 *    do), but 503 if any per-doc delete failed. This is a finished room's ONLY
 *    retry path, and the deletes are conditional + idempotent, so LiveKit
 *    redelivery is safe and wanted — a blanket 200 after a partial sweep would
 *    be a false ACK that strands ghosts.
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

  // 200 unless a room_finished sweep partially fails (→ 503, see below).
  let responseStatus = 200;

  try {
    const db = admin.firestore();

    // The moment LiveKit fired the event, validated to a sane epoch band.
    // 0 → watermark disabled downstream (fail open); see eventCreatedAtMs.
    const createdAtMs = eventCreatedAtMs(event.createdAt);

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
        let stale;
        try {
          stale = await db.collection("presence")
              .where("currentRoomId", "==", roomName)
              .get();
        } catch (queryErr) {
          // Couldn't even enumerate the room's presence — nothing was reaped.
          // 503 so LiveKit redelivers (redelivery is this room's only retry).
          functions.logger.error(
              `livekitWebhook: room_finished query failed for ${roomName}: ` +
              `${queryErr}`,
          );
          responseStatus = 503;
          break;
        }

        let reaped = 0;
        let skipped = 0;
        let failed = 0;
        for (const doc of stale.docs) {
          const ref = doc.ref;
          try {
            // Per-doc try/catch: a throw on one doc must not abandon the rest.
            const deleted = await db.runTransaction(async (tx) => {
              const snap = await tx.get(ref);
              if (!shouldReapPresence(snap, roomName, createdAtMs)) {
                return false;
              }
              tx.delete(ref);
              return true;
            });
            if (deleted) {
              reaped++;
            } else {
              skipped++;
            }
          } catch (docErr) {
            failed++;
            functions.logger.error(
                `livekitWebhook: room_finished failed to reap ${ref.id} ` +
                `in ${roomName}: ${docErr}`,
            );
          }
        }
        functions.logger.info(
            `livekitWebhook: room_finished for ${roomName} — ` +
            `attempted=${stale.size} reaped=${reaped} ` +
            `skipped=${skipped} failed=${failed}`,
        );
        // Honest completion: any per-doc failure → 503 so LiveKit redelivers
        // (deletes are conditional + idempotent, so redelivery is safe).
        if (failed > 0) responseStatus = 503;
        break;
      }

      default:
        // Ignore every other event type. Returning 200 (below) stops LiveKit
        // from retrying events we don't act on.
        break;
    }
  } catch (err) {
    // Reached only by a participant_left throw (room_finished handles its own
    // errors above). Verification already passed, so this is a Firestore-side
    // hiccup; keep 200 — a missed participant_left self-heals on the next
    // lifecycle event, so retries would only hammer without helping.
    functions.logger.error(`livekitWebhook: processing error: ${err}`);
  }

  res.status(responseStatus).send(responseStatus === 200 ? "OK" : "Retry");
});


