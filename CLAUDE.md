# CLAUDE.md - tech_world_firebase_functions

## Project Overview

Firebase Cloud Functions (Node.js) for Tech World. Handles user creation and LiveKit token generation.

## Build & Run

```bash
cd functions
npm install
npm run serve          # local emulator
firebase deploy --only functions  # deploy
firebase functions:log # view logs
```

## Key Files

- `functions/index.js`: Cloud function definitions
- `functions/package.json`: Node.js dependencies
- `functions/.env`: Environment variables (LIVEKIT_API_KEY, LIVEKIT_API_SECRET)

## Functions

### retrieveLiveKitToken (v2 callable)

Called by Flutter client to get a LiveKit token for joining a room.

```javascript
exports.retrieveLiveKitToken = onCall(async (request) => { ... });
```

**Parameters:** `{ roomName: string }`
**Returns:** LiveKit JWT token
**Auth:** Requires authenticated user

### getBotToken (v2 callable)

Called by bot service to get a LiveKit token for joining as `bot-claude`.

```javascript
exports.getBotToken = onCall(async (request) => { ... });
```

**Parameters:** `{ roomName: string, botSecret: string }`
**Returns:** LiveKit JWT token
**Auth:** Requires matching `BOT_SECRET` env var

### saveDoc (v1 auth trigger)

Auth trigger that fires on user creation:

```javascript
exports.saveDoc = functions.auth.user().onCreate(async (user) => { ... });
```

**What it does:**

1. Gets user info (email, uid) from auth event
2. Creates LiveKit AccessToken with:
   - Identity: user.uid
   - Name: user.email (or "Guest")
   - TTL: 10 minutes
   - Grant: roomJoin for "room"
3. Stores in Firestore `users/{uid}`:
   - name: displayName
   - email: email
   - token: LiveKit JWT

## Configuration Required

Create `functions/.env`:

```sh
LIVEKIT_API_KEY=<your-api-key>
LIVEKIT_API_SECRET=<your-api-secret>
BOT_SECRET=<secure-secret-for-bot-auth>
```

## Dependencies

- `firebase-functions`: v5.0.0
- `firebase-admin`: v12.1.0
- `livekit-server-sdk`: v2.4.0

## npm Scripts

```bash
npm run lint    # ESLint
npm run serve   # Local emulator
npm run shell   # Interactive shell
npm run deploy  # Deploy to Firebase
npm run logs    # View function logs
```

## Notes

- Uses Firebase Functions v2 style but Auth trigger from v1
- LiveKit SDK imported dynamically in function
- Token stored in Firestore for client retrieval
