/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const functions = require("firebase-functions");

// The Firebase Admin SDK to access Firestore.
const admin = require("firebase-admin");
admin.initializeApp();

exports.saveDoc = functions.auth.user().onCreate(async (user) => {
  functions.logger.info(`Email: ${user.email}, User ID: ${user.uid}`,
      {structuredData: true});
  
      const { AccessToken } = await import('livekit-server-sdk');

      let livekitName = user.email;
      if(livekitName == null) {
        livekitName = "Guest";
      }

      const at = new AccessToken(
        process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET, {
            identity: user.uid,
            name: livekitName,
            ttl: "10m", // token to expire after 10 minutes
          }
        );
  
      at.addGrant({roomJoin: true, room: "room"});

      token = await at.toJwt();

      const writeResult = await admin
      .firestore()
      .collection("users")
      .doc(user.uid).set({
        name: user.displayName,
        email: user.email,
        token: token,
      });
      
      functions.logger.info(`Doc added: ${writeResult.writeTime.toDate().toLocaleString()}.`);
    }
  );

