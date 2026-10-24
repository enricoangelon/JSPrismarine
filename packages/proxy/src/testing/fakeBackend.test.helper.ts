import { ClientPacketRegistry, SendPriority, deriveEncryptionKey } from '@jsprismarine/client';
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
import Link from '../Link';

import type { Logger } from '@jsprismarine/logger';
import type { InetAddress, RakNetSession } from '@jsprismarine/raknet';

/** How a fake backend behaves. */
export interface FakeBackendOptions {
    readonly port: number;
    readonly logger: Logger;
    /** Asks for encryption after the login, the way a Bedrock Dedicated Server does. */
    readonly encrypt?: boolean;
    /** Sent, encrypted, once the client has answered the encryption handshake. */
    readonly disconnectAfterHandshake?: string;
}

/** A running fake backend. */
export interface FakeBackend {
    /** Every packet id it decoded, in order. */
    readonly received: number[];
    /** Drops every connection at the RakNet level, with no `Disconnect` packet. */
    dropAll(): void;
    kill(): void;
}

const serialize = (packet: { serialize(stream: NetworkBinaryStream): Buffer }): Buffer =>
    packet.serialize(new NetworkBinaryStream());

const claimsOf = (token: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));

/** The handshake token. The proxy reads it without checking the signature, so it has none. */
const handshakeToken = (publicKeyDer: string, salt: Buffer): string =>
    `${[{ alg: 'ES384', x5u: publicKeyDer }, { salt: salt.toString('base64') }]
        .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
        .join('.')}.`;

/**
 * A backend that does only the network half of a login: compression and, if asked, encryption.
 *
 * It never sends `PlayStatus` or `StartGame`, so a client logging into it directly waits until
 * it times out. As a proxy's primary backend it is for testing the handshake; as a mirror it
 * shows which client packets reached it.
 */
export const startFakeBackend = (options: FakeBackendOptions): FakeBackend => {
    const { logger } = options;
    const received: number[] = [];
    const sessions = new Map<string, { session: RakNetSession; link: Link }>();

    const socket = new ServerSocket(
        10,
        false,
        new ServerName({
            getConfig: () => ({
                getMotd: () => 'fake backend',
                getGamemode: () => 'Survival',
                getMaxPlayers: () => 10
            }),
            getIdentifiers: () => ({ Protocol: 2193, MinecraftVersions: ['1.26.51'] })
        }),
        logger
    );

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
            'proxy',
            send,
            (packets) => {
                for (const packet of packets) {
                    const id = ClientPacketRegistry.readPacketId(packet);
                    received.push(id);

                    if (id === PacketIdentifier.REQUEST_NETWORK_SETTINGS) {
                        link.send([
                            serialize(
                                new NetworkSettingsPacket({
                                    compressionThreshold: 1,
                                    compressionAlgorithm: 0,
                                    clientThrottlingEnabled: false,
                                    clientThrottleThreshold: 0,
                                    clientThrottleScalar: 0
                                })
                            )
                        ]);
                        link.enableCompression({ algorithm: 0, threshold: 1 });
                    } else if (id === PacketIdentifier.LOGIN && options.encrypt) {
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
                    } else if (
                        id === PacketIdentifier.CLIENT_TO_SERVER_HANDSHAKE &&
                        options.disconnectAfterHandshake !== undefined
                    ) {
                        link.send([
                            serialize(
                                new DisconnectPacket({
                                    reason: 0,
                                    skipMessage: false,
                                    message: options.disconnectAfterHandshake
                                })
                            )
                        ]);
                    }
                }
            },
            logger
        );

        sessions.set(session.getAddress().toToken(), { session, link });
    });
    socket.on('encapsulated', (frame: Protocol.Frame, address: InetAddress) => {
        sessions.get(address.toToken())?.link.receive(frame.content);
    });
    socket.on('closeConnection', (address: InetAddress) => {
        sessions.delete(address.toToken());
    });

    socket.start('127.0.0.1', options.port);

    return {
        received,
        dropAll: () => {
            for (const { session } of sessions.values()) session.disconnect('dropped by the test');
        },
        kill: () => socket.kill()
    };
};
