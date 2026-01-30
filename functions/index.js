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

// The Firebase Admin SDK to access Firestore.
const admin = require("firebase-admin");
admin.initializeApp();

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

  const {AccessToken} = await import("livekit-server-sdk");

  const userName = request.auth.token.name ||
                   request.auth.token.email ||
                   "Guest";

  const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: request.auth.uid,
        name: userName,
        ttl: "1h",
      },
  );

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  });

  const token = await at.toJwt();
  functions.logger.info(
      `Token generated for user ${request.auth.uid} in room ${roomName}`,
  );
  return token;
});

/**
 * Callable function to retrieve a LiveKit token for the bot service.
 * The bot joins as 'bot-claude' participant.
 */
exports.getBotToken = onCall(async (request) => {
  // Verify request contains bot secret (simple auth for bot service)
  const botSecret = request.data.botSecret;
  if (botSecret !== process.env.BOT_SECRET) {
    throw new HttpsError("permission-denied", "Invalid bot credentials");
  }

  const roomName = request.data.roomName;
  if (!roomName || typeof roomName !== "string") {
    throw new HttpsError("invalid-argument", "roomName is required");
  }

  const {AccessToken} = await import("livekit-server-sdk");

  const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: "bot-claude",
        name: "Clawd",
        ttl: "24h", // Bot stays connected longer
      },
  );

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  });

  const token = await at.toJwt();
  functions.logger.info(`Bot token generated for room ${roomName}`);
  return token;
});

exports.saveDoc = functions.auth.user().onCreate(async (user) => {
  functions.logger.info(`Email: ${user.email}, User ID: ${user.uid}`,
      {structuredData: true});

  const {AccessToken} = await import("livekit-server-sdk");

  let livekitName = user.email;
  if (livekitName == null) {
    livekitName = "Guest";
  }

  const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET, {
        identity: user.uid,
        name: livekitName,
        ttl: "10m", // token to expire after 10 minutes
      },
  );

  at.addGrant({roomJoin: true, room: "room"});

  const token = await at.toJwt();

  const writeResult = await admin
      .firestore()
      .collection("users")
      .doc(user.uid).set({
        name: user.displayName,
        email: user.email,
        token: token,
      });

  const timestamp = writeResult.writeTime.toDate().toLocaleString();
  functions.logger.info(`Doc added: ${timestamp}.`);
},
);

