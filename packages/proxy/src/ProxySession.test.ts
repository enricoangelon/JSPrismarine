import { OfflineAuthProvider } from '@jsprismarine/auth';
import { Client, ClientPacketRegistry, SendPriority, deriveEncryptionKey } from '@jsprismarine/client';
import { Logger } from '@jsprismarine/logger';
import {
    DisconnectPacket,
    LoginPacket,
    NetworkBinaryStream,
    NetworkSettingsPacket,
    PacketIdentifier,
    ServerToClientHandshakePacket
} from '@jsprismarine/protocol';
import { ConnectionPriority, Protocol, ServerName, ServerSocket } from '@jsprismarine/raknet';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Link from './Link';
import Proxy from './Proxy';

import type { InetAddress, RakNetSession } from '@jsprismarine/raknet';

/**
 * A backend that asks for encryption, which JSPrismarine does not.
 *
 * It does what a Bedrock Dedicated Server does up to the end of the handshake: compression,
 * then a `ServerToClientHandshake` carrying its key and a salt, then encrypted batches both
 * ways. Once it has decrypted the proxy's `ClientToServerHandshake` it sends an encrypted
 * `Disconnect`, so the client seeing that message proves both directions worked.
 */

const BACKEND_PORT = 19292;
const PROXY_PORT = 19293;
const UNREACHABLE_PROXY_PORT = 19294;
const SECRET_MESSAGE = 'decrypted by the proxy';

const logger = new Logger('error');
let backend: ServerSocket | null = null;
let proxy: Proxy | null = null;
/** Every packet id the backend managed to decode, in order. */
const received: number[] = [];

const claimsOf = (token: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));

/** The handshake token. The proxy reads it without checking the signature, so it has none. */
const handshakeToken = (publicKeyDer: string, salt: Buffer): string =>
    [{ alg: 'ES384', x5u: publicKeyDer }, { salt: salt.toString('base64') }]
        .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
        .join('.') + '.';

const serialize = (packet: { serialize(stream: NetworkBinaryStream): Buffer }): Buffer =>
    packet.serialize(new NetworkBinaryStream());

const startEncryptingBackend = (): ServerSocket => {
    const socket = new ServerSocket(
        10,
        false,
        new ServerName({
            getConfig: () => ({ getMotd: () => 'backend', getGamemode: () => 'Survival', getMaxPlayers: () => 10 }),
            getIdentifiers: () => ({ Protocol: 2193, MinecraftVersions: ['1.26.51'] })
        }),
        logger
    );
    const links = new Map<string, Link>();

    socket.on('openConnection', (session: RakNetSession) => {
        const send = (payload: Buffer, priority: SendPriority) => {
            const frame = new Protocol.Frame();
            frame.reliability = Protocol.FrameReliability.RELIABLE_ORDERED;
            frame.orderChannel = 0;
            frame.content = payload;
            session.sendFrame(
                frame,
                priority === SendPriority.IMMEDIATE ? ConnectionPriority.IMMEDIATE : ConnectionPriority.NORMAL
            );
        };

        const link: Link = new Link(
            'test client',
            send,
            (packets) => {
                for (const packet of packets) {
                    const id = ClientPacketRegistry.readPacketId(packet);
                    received.push(id);

                    if (id === PacketIdentifier.REQUEST_NETWORK_SETTINGS) {
                        const settings = { compressionThreshold: 1, compressionAlgorithm: 0 };
                        link.send([
                            serialize(
                                new NetworkSettingsPacket({
                                    ...settings,
                                    clientThrottlingEnabled: false,
                                    clientThrottleThreshold: 0,
                                    clientThrottleScalar: 0
                                })
                            )
                        ]);
                        link.enableCompression({ algorithm: 0, threshold: 1 });
                    } else if (id === PacketIdentifier.LOGIN) {
                        const login = new LoginPacket().deserialize(new NetworkBinaryStream(packet));
                        const clientKey = claimsOf(JSON.parse(login.chainData).Token).cpk;
                        if (typeof clientKey !== 'string') throw new Error('The login carries no key');

                        const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
                        const salt = randomBytes(16);
                        const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
                        const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

                        link.send([
                            serialize(new ServerToClientHandshakePacket({ jwt: handshakeToken(publicKeyDer, salt) }))
                        ]);
                        // ECDH is symmetric, so the client's derivation gives the server's key too.
                        link.enableEncryption(deriveEncryptionKey(privateKeyPem, clientKey, salt));
                    } else if (id === PacketIdentifier.CLIENT_TO_SERVER_HANDSHAKE) {
                        link.send([
                            serialize(new DisconnectPacket({ reason: 0, skipMessage: false, message: SECRET_MESSAGE }))
                        ]);
                    }
                }
            },
            logger
        );

        links.set(session.getAddress().toToken(), link);
    });
    socket.on('encapsulated', (frame: Protocol.Frame, address: InetAddress) => {
        links.get(address.toToken())?.receive(frame.content);
    });

    socket.start('127.0.0.1', BACKEND_PORT);
    return socket;
};

beforeAll(() => {
    backend = startEncryptingBackend();
    proxy = new Proxy({
        listen: { host: '127.0.0.1', port: PROXY_PORT },
        backend: { host: '127.0.0.1', port: BACKEND_PORT },
        logger
    });
    proxy.start();
});

afterAll(async () => {
    await proxy?.close();
    backend?.kill();
});

describe('a backend that asks for encryption', () => {
    it('gets its handshake answered by the proxy, and its encrypted packets reach the client', async () => {
        const client = new Client({
            host: '127.0.0.1',
            port: PROXY_PORT,
            logger,
            auth: new OfflineAuthProvider({ displayName: 'Encrypted' }),
            loginTimeoutMs: 15_000
        });

        await expect(client.connect()).rejects.toThrow(SECRET_MESSAGE);

        // The handshake reply was decrypted by the backend, so the proxy encrypted it with the right key.
        expect(received).toEqual([
            PacketIdentifier.REQUEST_NETWORK_SETTINGS,
            PacketIdentifier.LOGIN,
            PacketIdentifier.CLIENT_TO_SERVER_HANDSHAKE
        ]);
    }, 30_000);
});

describe('a backend that is not there', () => {
    it('tells the client why, instead of leaving it to time out', async () => {
        const unreachable = new Proxy({
            listen: { host: '127.0.0.1', port: UNREACHABLE_PROXY_PORT },
            // Nothing listens here.
            backend: { host: '127.0.0.1', port: UNREACHABLE_PROXY_PORT + 1 },
            logger,
            connectTimeoutMs: 1000
        });
        unreachable.start();

        try {
            const client = new Client({
                host: '127.0.0.1',
                port: UNREACHABLE_PROXY_PORT,
                logger,
                auth: new OfflineAuthProvider({ displayName: 'Stranded' }),
                loginTimeoutMs: 15_000
            });

            await expect(client.connect()).rejects.toThrow('Cannot reach the backend at 127.0.0.1:19295');
        } finally {
            await unreachable.close();
        }
    }, 30_000);
});
