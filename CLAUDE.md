# CLAUDE.md - tech_world_firebase_functions

## Project Overview

Firebase Cloud Functions (Node.js) for Tech World. Handles user creation, LiveKit token generation with agent dispatch, and Cloud Run bot wake-up.

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
- `functions/.env`: Environment variables

## Functions

### retrieveLiveKitToken (v2 callable)

Called by Flutter client to get a LiveKit token for joining a room. Dispatches both bot agents (Clawd and Gremlin) and wakes their Cloud Run services.

**Parameters:** `{ roomName: string }`
**Returns:** LiveKit JWT token
**Auth:** Requires authenticated user

**Agent dispatch:** The token includes `RoomConfiguration` with named `RoomAgentDispatch` entries for `"clawd"` and `"gremlin"`. LiveKit dispatches both bots when the user joins.

**Bot wake-up:** Calls `wakeBots()` which sends fire-and-forget HTTP POST requests to the Cloud Run bot services using IAM-authenticated `google-auth-library`. This ensures containers are warm for the dispatch. Failures are logged but don't block token generation.

### getBotToken (v2 callable)

Called by bot service to get a LiveKit token for joining as a bot participant.

**Parameters:** `{ roomName: string, botSecret: string }`
**Returns:** LiveKit JWT token
**Auth:** Requires matching `BOT_SECRET` env var (timing-safe comparison)

### saveDoc (v1 auth trigger)

Auth trigger that fires on user creation. Stores user info and a short-lived LiveKit token in Firestore.

## Configuration Required

Create `functions/.env`:

```sh
LIVEKIT_API_KEY=<your-api-key>
LIVEKIT_API_SECRET=<your-api-secret>
BOT_SECRET=<secure-secret-for-bot-auth>
CLAWD_BOT_URL=https://clawd-bot-<id>.us-central1.run.app
GREMLIN_BOT_URL=https://gremlin-bot-<id>.us-central1.run.app
```

## Dependencies

- `firebase-functions`: v5.0.0
- `firebase-admin`: v12.1.0
- `livekit-server-sdk`: v2.15.0 (provides `RoomAgentDispatch`, `RoomConfiguration`)
- `google-auth-library`: IAM auth for Cloud Run service-to-service calls
- **Node.js runtime**: 22 (configured in `package.json` engines)

## Agent Dispatch

LiveKit's default automatic agent dispatch only fires for *new* rooms. The `tech-world` room has a 5-minute `empty_timeout` on LiveKit Cloud, so if users sign out and back in quickly the room persists and the bot never gets dispatched.

The fix is **token-based dispatch**: `retrieveLiveKitToken` sets `at.roomConfig` with named `RoomAgentDispatch` entries for both `"clawd"` and `"gremlin"`. When the token is used to join a room, LiveKit reads the dispatch config and sends job requests to the matching agent workers.

## Notes

- Uses Firebase Functions v2 style but Auth trigger from v1
- LiveKit SDK imported dynamically in each function (ESM package in CommonJS context)
- Node.js 18 was decommissioned 2025-10-30; runtime upgraded to Node.js 22
