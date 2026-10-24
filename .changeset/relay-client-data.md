---
'@jsprismarine/auth': patch
---

Add a `clientDataPayload` option to `OfflineAuthProvider` that sends another client's client data fields as they are, so a proxy can re-sign a real client's login without losing its skin or device fields.
