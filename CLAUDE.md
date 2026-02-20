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

Called by Flutter client to get a LiveKit token for joining a room. Includes agent dispatch configuration so the Clawd bot is automatically dispatched when users connect.

```javascript
exports.retrieveLiveKitToken = onCall(async (request) => { ... });
```

**Parameters:** `{ roomName: string }`
**Returns:** LiveKit JWT token
**Auth:** Requires authenticated user

**Agent dispatch:** The token includes a `RoomConfiguration` with `RoomAgentDispatch` (empty `agentName` = dispatch to any available worker). This ensures the bot is dispatched every time a user joins, regardless of whether the room is new or already exists. See "Agent Dispatch" section below for details.

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
- `livekit-server-sdk`: v2.15.0 (provides `RoomAgentDispatch`, `RoomConfiguration`)
- **Node.js runtime**: 22 (configured in `package.json` engines)

## npm Scripts

```bash
npm run lint    # ESLint
npm run serve   # Local emulator
npm run shell   # Interactive shell
npm run deploy  # Deploy to Firebase
npm run logs    # View function logs
```

## Agent Dispatch

LiveKit's default automatic agent dispatch only fires for *new* rooms. The `tech-world` room has a 5-minute `empty_timeout` on LiveKit Cloud, so if users sign out and back in quickly the room persists and the bot never gets dispatched.

The fix is **token-based dispatch**: `retrieveLiveKitToken` sets `at.roomConfig` with a `RoomAgentDispatch` entry. When the token is used to join a room, LiveKit reads the dispatch config and sends a job request to an available agent worker (the Clawd bot in `tech_world_bot`).

The `agentName` is set to `""` (empty string), which dispatches to any registered worker without requiring a named agent.

## Notes

- Uses Firebase Functions v2 style but Auth trigger from v1
- LiveKit SDK imported dynamically in each function (ESM package in CommonJS context)
- Token stored in Firestore for client retrieval (`saveDoc` function)
- Node.js 18 was decommissioned 2025-10-30; runtime upgraded to Node.js 22
