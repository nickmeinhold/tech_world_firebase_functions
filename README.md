# Tech World Firebase Functions

Firebase Cloud Functions for the Tech World multiplayer game. Handles LiveKit token generation with embedded agent dispatch.

## Features

- Generates LiveKit access tokens with `RoomAgentDispatch` embedded in `RoomConfiguration` — ensures Clawd, Gremlin, and Dreamfinder bots are dispatched whether the room is new or already exists (token-based dispatch; not limited to new rooms)
- Provides bot authentication for LiveKit room access

## Prerequisites

- Node.js 22+
- Firebase CLI (`npm install -g firebase-tools`)
- Firebase project with Authentication enabled
- LiveKit account with API credentials

## Setup

1. Navigate to the functions directory:

   ```bash
   cd functions
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Create environment file `functions/.env`:

   ```sh
   LIVEKIT_API_KEY=<your-api-key>
   LIVEKIT_API_SECRET=<your-api-secret>
   BOT_SECRET=<secure-secret-for-bot-auth>
   ```

4. Login to Firebase:

   ```bash
   firebase login
   ```

## Local Development

Run the Firebase emulator:

```bash
npm run serve
```

Or use the Firebase shell:

```bash
npm run shell
```

## Deployment

```bash
firebase deploy --only functions
```

## View Logs

```bash
firebase functions:log
```

## Functions

### retrieveLiveKitToken

Callable function that generates a LiveKit token for authenticated users. Embeds `RoomAgentDispatch` for Clawd, Gremlin, and Dreamfinder — ensuring bots are dispatched on every room join, new or existing.

### getBotToken

Callable function that generates a LiveKit token for bot services. Supports both Clawd and Gremlin via the `botName` parameter. Uses timing-safe secret comparison.

## Dependencies

- `firebase-admin`: Firebase Admin SDK
- `firebase-functions`: Cloud Functions framework
- `livekit-server-sdk`: LiveKit token generation

## Project Structure

```
tech_world_firebase_functions/
└── functions/
    ├── index.js      # Cloud function definitions
    ├── package.json  # Node.js dependencies
    ├── .env          # Environment variables (not committed)
    └── .eslintrc.js  # ESLint configuration
```
