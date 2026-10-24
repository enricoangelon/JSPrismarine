---
'@jsprismarine/proxy': patch
---

Add `@jsprismarine/proxy`, a proxy that relays Bedrock clients to one backend server. It re-signs the client's login under an offline identity, answers the backend's encryption handshake, and can write each player's packets to an NDJSON recording.
