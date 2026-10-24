# @jsprismarine/proxy

A Minecraft: Bedrock Edition proxy. It accepts clients, relays each one to a backend server, and can record every packet the backend sends and receives. You can put it in front of JSPrismarine or in front of a Bedrock Dedicated Server (BDS), and connect the retail game to it.

It can also mirror: send the same client packets to a second server at the same time and record what both servers answer. Playing on BDS with JSPrismarine as the mirror shows, moment by moment, where JSPrismarine behaves differently from vanilla.

This package is private and is not published to npm yet.

## Running it

Start the backend first, then point the proxy at it:

```sh
pnpm --filter @jsprismarine/proxy start --backend 127.0.0.1:19133 --record captures
```

The proxy listens on `0.0.0.0:19132` unless you pass `--listen`. Add the proxy's address as a server in the game and join it as you would any other server. Run `--help` for the full list of options.

To relay to BDS, set these in its `server.properties`. BDS prints a "TRANSPORT TYPE ERROR" at startup with `transport=raknet`; it still accepts RakNet connections, so you can ignore it.

| Setting | Value | Why |
| --- | --- | --- |
| `online-mode` | `false` | The proxy logs in with an offline identity, not your Xbox account. |
| `transport` | `raknet` | From 1.26.50 BDS defaults to NetherNet, which the proxy does not speak. |
| `server-port` | not `19132` | The proxy usually has that port. |
| `enable-lan-visibility` | `false` | Keeps BDS off 19132 and 19133 so both can run on one machine. |

Keep display names to 16 characters or fewer. BDS disconnects a longer name with an empty reason, and the proxy logs a warning when it sees one.

## Mirroring to JSPrismarine

Run BDS and JSPrismarine side by side, then give the proxy both:

```sh
pnpm --filter @jsprismarine/proxy start --backend 127.0.0.1:19133 --mirror 127.0.0.1:19134 --record captures
```

You play on the `--backend` server and see only its packets. The `--mirror` server gets every packet your game sends, at the moment it sends it, and the proxy records its answers and throws them away. Each server negotiates its own compression and encryption with the proxy, so the two don't have to agree on either.

The comparison is only meaningful when both servers start from the same state:

- Copy the BDS world folder into JSPrismarine's world directory before each session, because a world changes as soon as anyone plays in it. JSPrismarine reads BDS's LevelDB worlds directly.
- Set the same game rules on both, and turn off what neither can reproduce from the other: the daylight and weather cycles, mob spawning, and random ticks.

The mirror is best effort. If it can't be reached when you join, or it disconnects you later, you keep playing on the backend and the proxy logs a warning.

## What the proxy changes

The proxy forwards packets in both directions as they arrive, batch for batch. Three steps of the login are the exceptions, because each connection has to negotiate them separately:

- Compression. The client's `RequestNetworkSettings` opens the connection to the backend, and the backend's `NetworkSettings` goes back to the client unchanged. Both connections then use the compression the backend chose.
- The login. The proxy reads the client's name, uuid and client data (skin, persona pieces, device) from its `Login`, then signs a new offline login with a key of its own. It can't forward the original, because the backend encrypts against the key in the login and only the client has that key's private half. The client's own tokens, Xbox ones included, never leave the proxy and are not recorded.
- Encryption. When the backend sends `ServerToClientHandshake`, the proxy answers it and encrypts the backend connection. The client never sees the handshake, and its connection to the proxy stays unencrypted, which the game accepts from a server that doesn't ask for encryption.

## Recordings

With `--record <dir>`, each player gets one file named after the time they connected and their address. The file is newline-delimited JSON. The first line describes the session and every line after it is one packet:

```json
{"type":"session","format":2,"startedAt":"2026-10-24T09:52:53.120Z","client":"127.0.0.1:50123","backend":"127.0.0.1:19133","mirror":"127.0.0.1:19134"}
{"type":"packet","t":0.412,"direction":"serverbound","backend":"primary","id":193,"name":"REQUEST_NETWORK_SETTINGS","size":6,"payload":"wQEAAAiR"}
```

`t` is milliseconds since the session started, on one clock for both servers. `direction` is `serverbound` for packets sent to a server and `clientbound` for packets it sent back. `backend` says which server: `primary` is the one you play on and `mirror` is the second one. The header's `mirror` is `null` when nothing was mirrored. `payload` is the whole packet in base64, header included, decompressed and decrypted but otherwise byte for byte what crossed the wire. `name` is `null` for packet ids the protocol package doesn't name yet.

A recording is each server's side of the conversation: the login in it is the one the proxy signed for that server, and it includes the encryption handshake the client never saw. That makes it suitable for replaying against another server.

The proxy writes recordings in the background, so a file can still be growing for a few seconds after you leave. Read it once the proxy has logged the disconnect.

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
- Packets go to the mirror unchanged. Some client packets name things the server assigned, such as entity runtime ids in `Interact` or item stack network ids in `ItemStackRequest`. When the two servers assigned different ids, the mirror gets ids that mean something else to it, or nothing at all. Rewriting them is the next step.
- The proxy records both servers but doesn't compare them yet.
- The proxy doesn't verify the client's login. That's fine for the offline backends it supports, and it means anyone who can reach the proxy can join under any name.
- Only RakNet is supported, on both sides.
