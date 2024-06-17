# tech_world_firebase_functions

## Deploy

```sh
firebase deploy --only functions
```

## LiveKit Token

Currently we have an endpoint running on Cloud Run that the cloud
function hits to get a token.

I couldn't get JS LiveKit SDK to work so I wrote a webserver in Rust
and used the Rust SDK.
