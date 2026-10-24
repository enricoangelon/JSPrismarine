---
'@jsprismarine/client': patch
---

Export `readHandshake` and `deriveEncryptionKey` from the package entry point, so a proxy that logs into a server can complete the encryption handshake the same way the client does.
