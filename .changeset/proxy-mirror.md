---
'@jsprismarine/proxy': patch
---

Add a `--mirror` backend that gets the same client packets as the server you play on. The proxy records what both servers answer on one clock and never sends the mirror's packets to the client. Recordings move to format 2, which adds a `backend` field to each packet line and a `mirror` address to the header.
