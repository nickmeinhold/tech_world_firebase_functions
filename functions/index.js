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

// Module-scoped GoogleAuth instance — reused across warm invocations.
const {GoogleAuth} = require("google-auth-library");
const googleAuth = new GoogleAuth();

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
 * Wake both bot Cloud Run services with fire-and-forget HTTP requests.
 *
 * Uses Google Auth to generate an identity token for service-to-service
 * IAM authentication. Failures are swallowed — LiveKit dispatch handles
 * the race if a bot isn't ready yet.
 */
async function wakeBots() {
  const urls = [
    process.env.CLAWD_BOT_URL,
    process.env.GREMLIN_BOT_URL,
  ].filter(Boolean);

  if (urls.length === 0) return;

  await Promise.allSettled(
      urls.map(async (url) => {
        try {
          const client = await googleAuth.getIdTokenClient(url);
          await client.request({url, method: "POST", timeout: 5000});
          functions.logger.info(`Woke bot at ${url}`);
        } catch (err) {
          functions.logger.warn(
              `Failed to wake bot at ${url}:`, err.message,
          );
        }
      }),
  );
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
    ],
  });

  const token = await at.toJwt();
  functions.logger.info(
      `Token generated for user ${request.auth.uid} in room ${roomName}`,
  );

  // Fire-and-forget: wake bot Cloud Run services so they're warm for dispatch.
  wakeBots().catch((err) =>
    functions.logger.warn("wakeBots error:", err.message),
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


