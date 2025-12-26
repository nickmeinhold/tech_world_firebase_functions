# Tech World Firebase Functions

Firebase Cloud Functions for the Tech World multiplayer game. Handles user creation events and LiveKit token generation.

## Features

- Triggers on Firebase Auth user creation
- Generates LiveKit access tokens for video chat
- Stores user data and tokens in Firestore

## Prerequisites

- Node.js 18+
- Firebase CLI (`npm install -g firebase-tools`)
- Firebase project with Authentication and Firestore enabled
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

Deploy to Firebase:

```bash
firebase deploy --only functions
```

Or use the npm script:

```bash
npm run deploy
```

## View Logs

```bash
npm run logs
# or
firebase functions:log
```

## Functions

### saveDoc

Triggered when a new user is created in Firebase Auth. This function:

1. Creates a LiveKit access token for the user
2. Stores user data (name, email, token) in Firestore `users` collection

## Dependencies

- `firebase-admin`: Firebase Admin SDK for Firestore access
- `firebase-functions`: Cloud Functions framework
- `livekit-server-sdk`: LiveKit token generation
- `axios`: HTTP client

## Project Structure

```
tech_world_firebase_functions/
└── functions/
    ├── index.js      # Cloud function definitions
    ├── package.json  # Node.js dependencies
    ├── .env          # Environment variables (not committed)
    └── .eslintrc.js  # ESLint configuration
```
