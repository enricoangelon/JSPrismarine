import {
    ClientPacketRegistry,
    RakNetTransport,
    SendPriority,
    deriveEncryptionKey,
    readHandshake
} from '@jsprismarine/client';
import {
    ClientToServerHandshakePacket,
    DisconnectPacket,
    LoginPacket,
    NetworkBinaryStream,
    NetworkSettingsPacket,
    PacketIdentifier,
    ServerToClientHandshakePacket
} from '@jsprismarine/protocol';
import { ConnectionPriority, Protocol } from '@jsprismarine/raknet';
import Link from './Link';
import { MAX_DISPLAY_NAME_LENGTH, createRelayAuth, readRelayedLogin } from './LoginRelay';

import type { Logger } from '@jsprismarine/logger';
import type { NetworkPacket } from '@jsprismarine/protocol';
import type { RakNetSession } from '@jsprismarine/raknet';
import type PacketRecorder from './PacketRecorder';
import type { PacketDirection } from './PacketRecorder';

/** Where a proxy sends its players. */
export interface BackendAddress {
    readonly host: string;
    readonly port: number;
}

/** What a session needs from the proxy that owns it. */
export interface ProxySessionOptions {
    readonly backend: BackendAddress;
    readonly logger: Logger;
    /** Receives every packet exchanged with the backend; null records nothing. */
    readonly recorder: PacketRecorder | null;
    /** How long the backend gets to accept the RakNet connection. */
    readonly connectTimeoutMs?: number;
    /** Called once, after both connections are closed. */
    readonly onClose?: (reason: string) => void;
}

/** The DisconnectPacket reason the proxy sends when the backend could not be reached. */
const DISCONNECT_REASON_UNKNOWN = 0;

const serialize = (packet: NetworkPacket<unknown>): Buffer => packet.serialize(new NetworkBinaryStream());

/**
 * One player passing through the proxy: the connection from the client and the one to the backend.
 *
 * Everything is forwarded as it arrived, batch for batch, apart from the steps each connection
 * has to negotiate on its own:
 *
 * - `RequestNetworkSettings` from the client opens the backend connection, and goes on to the
 *   backend unchanged. The backend's `NetworkSettings` goes back to the client unchanged, and
 *   both links switch to the compression it names.
 * - `Login` is signed again, by an offline identity carrying the client's name, uuid and
 *   client data. The proxy cannot reuse the client's signature: the backend encrypts against
 *   the key in the login, and only the client holds that key's private half.
 * - `ServerToClientHandshake` is answered by the proxy and not forwarded. The client link
 *   stays unencrypted, which the client accepts from any server that does not ask for it.
 */
export default class ProxySession {
    private readonly client: Link;
    private backend: Link | null = null;
    private transport: RakNetTransport | null = null;

    /** The private key of the identity the backend login was signed with, once there is one. */
    private privateKey: string | null = null;

    /** Serverbound batches, one after another, because opening the backend and signing the login are asynchronous. */
    private serverbound: Promise<void> = Promise.resolve();
    /** Set once the backend's own `Disconnect` has been passed on, so the proxy does not add a second. */
    private disconnectForwarded = false;
    private closing = false;
    private closed = false;

    public constructor(
        private readonly session: RakNetSession,
        private readonly options: ProxySessionOptions
    ) {
        this.client = new Link(
            'client',
            (payload, priority) => this.sendToClient(payload, priority),
            (packets) => this.onClientPackets(packets),
            options.logger
        );
    }

    /** Passes on one batch the client sent. */
    public receiveFromClient(payload: Buffer): void {
        this.client.receive(payload);
    }

    /** Closes the backend connection after the client has gone. */
    public onClientClosed(reason: string): void {
        this.finish(`client left: ${reason}`);
    }

    /**
     * Ends both connections.
     *
     * The client is sent a `Disconnect` carrying the reason, because a RakNet disconnect on its
     * own leaves the game showing a generic message that says nothing about the backend.
     */
    public async close(reason: string): Promise<void> {
        if (this.closing || this.closed) return;
        this.closing = true;

        if (!this.disconnectForwarded) {
            this.client.send(
                [
                    serialize(
                        new DisconnectPacket({ reason: DISCONNECT_REASON_UNKNOWN, skipMessage: false, message: reason })
                    )
                ],
                SendPriority.IMMEDIATE
            );
        }
        await this.client.flush();

        this.session.disconnect(reason);
        this.finish(reason);
    }

    private finish(reason: string): void {
        if (this.closed) return;
        this.closed = true;

        this.transport?.close(reason);
        void this.options.recorder?.close();
        this.options.onClose?.(reason);
    }

    private sendToClient(payload: Buffer, priority: SendPriority): void {
        const frame = new Protocol.Frame();
        // Reliable ordered on channel 0, as Minecraft sends everything.
        frame.reliability = Protocol.FrameReliability.RELIABLE_ORDERED;
        frame.orderChannel = 0;
        frame.content = payload;

        this.session.sendFrame(
            frame,
            priority === SendPriority.IMMEDIATE ? ConnectionPriority.IMMEDIATE : ConnectionPriority.NORMAL
        );
    }

    private onClientPackets(packets: Buffer[]): void {
        this.serverbound = this.serverbound
            .then(() => this.forwardToBackend(packets))
            .catch(async (error: unknown) => {
                await this.close(`Proxy error: ${error instanceof Error ? error.message : String(error)}`);
            });
    }

    private async forwardToBackend(packets: Buffer[]): Promise<void> {
        if (this.closed) return;

        const forwarded: Buffer[] = [];

        for (const packet of packets) {
            const id = ClientPacketRegistry.readPacketId(packet);

            if (id === PacketIdentifier.REQUEST_NETWORK_SETTINGS && this.backend === null) {
                await this.connectBackend();
                forwarded.push(packet);
            } else if (id === PacketIdentifier.LOGIN) {
                forwarded.push(await this.relayLogin(packet));
            } else {
                forwarded.push(packet);
            }
        }

        if (this.backend === null) {
            throw new Error('The client did not start with RequestNetworkSettings');
        }

        this.sendToBackend(forwarded, SendPriority.NORMAL);
    }

    private async connectBackend(): Promise<void> {
        const { host, port } = this.options.backend;
        const transport = new RakNetTransport(this.options.logger, {
            host,
            port,
            timeoutMs: this.options.connectTimeoutMs
        });
        const backend = new Link(
            'backend',
            (payload, priority) => transport.send(payload, priority),
            (packets) => this.onBackendPackets(packets),
            this.options.logger
        );

        transport.on('batch', (payload) => backend.receive(payload));
        transport.on('close', (reason) => void this.close(`The backend closed the connection: ${reason}`));

        this.transport = transport;

        try {
            await transport.connect();
        } catch (error: unknown) {
            throw new Error(
                `Cannot reach the backend at ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        this.backend = backend;
        this.options.logger.debug(`Connected to the backend at ${host}:${port}`);
    }

    private async relayLogin(packet: Buffer): Promise<Buffer> {
        const relayed = readRelayedLogin(new LoginPacket().deserialize(new NetworkBinaryStream(packet)));

        if (relayed.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
            this.options.logger.warn(
                `${relayed.displayName} is longer than ${MAX_DISPLAY_NAME_LENGTH} characters, which a Bedrock Dedicated Server refuses with an empty reason`
            );
        }

        const auth = createRelayAuth(relayed);
        // Read now rather than when the handshake arrives: the key has to be derived inside the
        // backend link's inbound chain, before the encrypted batch behind the handshake is read.
        this.privateKey = await auth.getIdentityPrivateKey();

        const { host, port } = this.options.backend;
        const credentials = await auth.createLoginCredentials({
            serverAddress: `${host}:${port}`,
            protocolVersion: relayed.protocolVersion
        });

        this.options.logger.info(`Relaying ${relayed.displayName} to ${host}:${port}`);

        return serialize(
            new LoginPacket({
                protocolVersion: relayed.protocolVersion,
                chainData: credentials.chainData,
                clientData: credentials.clientData
            })
        );
    }

    private sendToBackend(packets: readonly Buffer[], priority: SendPriority): void {
        for (const packet of packets) this.record('serverbound', packet);
        this.backend?.send(packets, priority);
    }

    private onBackendPackets(packets: Buffer[]): void {
        let forwarded: Buffer[] = [];

        for (const packet of packets) {
            this.record('clientbound', packet);

            const id = ClientPacketRegistry.readPacketId(packet);

            if (id === PacketIdentifier.NETWORK_SETTINGS) {
                const settings = new NetworkSettingsPacket().deserialize(new NetworkBinaryStream(packet));
                const compression = {
                    algorithm: settings.compressionAlgorithm,
                    threshold: settings.compressionThreshold
                };

                this.backend?.enableCompression(compression);

                // Sent before the client link switches over, because NetworkSettings itself
                // travels uncompressed and the client expects compression from the next batch.
                this.client.send([...forwarded, packet], SendPriority.IMMEDIATE);
                forwarded = [];
                this.client.enableCompression(compression);
            } else if (id === PacketIdentifier.SERVER_TO_CLIENT_HANDSHAKE) {
                this.answerHandshake(packet);
            } else {
                if (id === PacketIdentifier.DISCONNECT) this.disconnectForwarded = true;
                forwarded.push(packet);
            }
        }

        this.client.send(forwarded);
    }

    private answerHandshake(packet: Buffer): void {
        if (this.privateKey === null) throw new Error('The backend asked for encryption before the login');

        const { jwt } = new ServerToClientHandshakePacket().deserialize(new NetworkBinaryStream(packet));
        const { publicKeyDer, salt } = readHandshake(jwt);

        this.backend?.enableEncryption(deriveEncryptionKey(this.privateKey, publicKeyDer, salt));
        // Encrypted, like every batch after the handshake.
        this.sendToBackend([serialize(new ClientToServerHandshakePacket({}))], SendPriority.IMMEDIATE);
    }

    private record(direction: PacketDirection, packet: Buffer): void {
        this.options.recorder?.record(direction, packet);
    }
}
