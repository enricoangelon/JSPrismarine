# @jsprismarine/proxy

A Minecraft: Bedrock Edition proxy. It accepts clients, relays each one to a single backend server, and can record every packet the backend sends and receives. You can put it in front of JSPrismarine or in front of a Bedrock Dedicated Server (BDS), and connect the retail game to it.

The main use today is capturing what a real client and a real server say to each other, so JSPrismarine's packets can be checked against them.

This package is private and is not published to npm yet.

## Running it

Start the backend first, then point the proxy at it:

```sh
pnpm --filter @jsprismarine/proxy start --backend 127.0.0.1:19133 --record captures
```

The proxy listens on `0.0.0.0:19132` unless you pass `--listen`. Add the proxy's address as a server in the game and join it as you would any other server. Run `--help` for the full list of options.

To relay to BDS, set these in its `server.properties`:

| Setting | Value | Why |
| --- | --- | --- |
| `online-mode` | `false` | The proxy logs in with an offline identity, not your Xbox account. |
| `transport` | `raknet` | From 1.26.50 BDS defaults to NetherNet, which the proxy does not speak. |
| `server-port` | not `19132` | The proxy usually has that port. |
| `enable-lan-visibility` | `false` | Keeps BDS off 19132 and 19133 so both can run on one machine. |

Keep display names to 16 characters or fewer. BDS disconnects a longer name with an empty reason, and the proxy logs a warning when it sees one.

## What the proxy changes

The proxy forwards packets in both directions as they arrive, batch for batch. Three steps of the login are the exceptions, because each connection has to negotiate them separately:

- Compression. The client's `RequestNetworkSettings` opens the connection to the backend, and the backend's `NetworkSettings` goes back to the client unchanged. Both connections then use the compression the backend chose.
- The login. The proxy reads the client's name, uuid and client data (skin, persona pieces, device) from its `Login`, then signs a new offline login with a key of its own. It can't forward the original, because the backend encrypts against the key in the login and only the client has that key's private half. The client's own tokens, Xbox ones included, never leave the proxy and are not recorded.
- Encryption. When the backend sends `ServerToClientHandshake`, the proxy answers it and encrypts the backend connection. The client never sees the handshake, and its connection to the proxy stays unencrypted, which the game accepts from a server that doesn't ask for encryption.

## Recordings

With `--record <dir>`, each player gets one file named after the time they connected and their address. The file is newline-delimited JSON. The first line describes the session and every line after it is one packet:

```json
{"type":"session","format":1,"startedAt":"2026-10-24T09:52:53.120Z","client":"127.0.0.1:50123","backend":"127.0.0.1:19133"}
{"type":"packet","t":0.412,"direction":"serverbound","id":193,"name":"REQUEST_NETWORK_SETTINGS","size":6,"payload":"wQEAAAiR"}
```

`t` is milliseconds since the session started. `direction` is `serverbound` for packets sent to the backend and `clientbound` for packets it sent back. `payload` is the whole packet in base64, header included, decompressed and decrypted but otherwise byte for byte what crossed the wire. `name` is `null` for packet ids the protocol package doesn't name yet.

A recording is the backend's side of the conversation: the login in it is the one the proxy signed, and it includes the encryption handshake the client never saw. That makes it suitable for replaying against another server.

Recordings contain the player's name, uuid and skin. Treat them as personal data when you share them.

## Using it from code

```typescript
import { Proxy } from '@jsprismarine/proxy';

const proxy = new Proxy({
    listen: { host: '0.0.0.0', port: 19132 },
    backend: { host: '127.0.0.1', port: 19133 },
    recordDir: 'captures'
});

proxy.start();
// Later:
await proxy.close();
```

## Limits

- Every client goes to the same backend. There is no switching between servers yet.
- The proxy doesn't verify the client's login. That's fine for the offline backends it supports, and it means anyone who can reach the proxy can join under any name.
- Only RakNet is supported, on both sides.
