import {
    ClientPacketRegistry,
    RakNetTransport,
    SendPriority,
    deriveEncryptionKey,
    readHandshake
} from '@jsprismarine/client';
import {
    ClientToServerHandshakePacket,
    LoginPacket,
    NetworkBinaryStream,
    NetworkSettingsPacket,
    PacketIdentifier,
    ServerToClientHandshakePacket
} from '@jsprismarine/protocol';
import Link from './Link';

import type { IAuthProvider } from '@jsprismarine/auth';
import type { Logger } from '@jsprismarine/logger';
import type { CompressionSettings, NetworkPacket } from '@jsprismarine/protocol';
import type { RelayedLogin } from './LoginRelay';
import type PacketRecorder from './PacketRecorder';
import type { BackendRole } from './PacketRecorder';

/** Where a proxy sends its players. */
export interface BackendAddress {
    readonly host: string;
    readonly port: number;
}

/** How a backend connection is set up, and where what it receives goes. */
export interface BackendConnectionOptions {
    readonly role: BackendRole;
    readonly address: BackendAddress;
    readonly logger: Logger;
    /** Receives every packet exchanged with this backend; null records nothing. */
    readonly recorder: PacketRecorder | null;
    /** How long the backend gets to accept the RakNet connection. */
    readonly connectTimeoutMs?: number;
    /**
     * Receives what the backend sends, minus the encryption handshake, which the connection
     * answers itself.
     */
    readonly onPackets: (packets: Buffer[]) => void;
    /** Called once when the connection closes, whichever side closed it. */
    readonly onClose: (reason: string) => void;
}

const serialize = (packet: NetworkPacket<unknown>): Buffer => packet.serialize(new NetworkBinaryStream());

/** Reads the compression a `NetworkSettings` packet names. */
export const readCompression = (packet: Buffer): CompressionSettings => {
    const settings = new NetworkSettingsPacket().deserialize(new NetworkBinaryStream(packet));
    return { algorithm: settings.compressionAlgorithm, threshold: settings.compressionThreshold };
};

/**
 * The proxy's connection to one backend, as a client of it.
 *
 * It negotiates compression and encryption with that backend on its own, so a session can hold
 * two of these, to two servers that chose different settings, and send both the same packets.
 * Everything it sends and receives is recorded under its role.
 */
export default class BackendConnection {
    private readonly transport: RakNetTransport;
    private readonly link: Link;

    /** The private key of the identity this backend's login was signed with, once there is one. */
    private privateKey: string | null = null;
    private closed = false;

    public constructor(private readonly options: BackendConnectionOptions) {
        const { host, port } = options.address;

        this.transport = new RakNetTransport(options.logger, { host, port, timeoutMs: options.connectTimeoutMs });
        this.link = new Link(
            `${options.role} backend`,
            (payload, priority) => this.transport.send(payload, priority),
            (packets) => this.onBackendPackets(packets),
            options.logger
        );

        this.transport.on('batch', (payload) => this.link.receive(payload));
        this.transport.on('close', (reason) => this.onTransportClosed(reason));
    }

    /** `host:port`, for log lines and recordings. */
    public getAddress(): string {
        return `${this.options.address.host}:${this.options.address.port}`;
    }

    /**
     * Opens the RakNet connection.
     * @throws When the backend does not accept it in time.
     */
    public async connect(): Promise<void> {
        try {
            await this.transport.connect();
        } catch (error: unknown) {
            throw new Error(
                `Cannot reach the ${this.options.role} backend at ${this.getAddress()}: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }

        this.options.logger.debug(`Connected to the ${this.options.role} backend at ${this.getAddress()}`);
    }

    /**
     * Signs the client's login for this backend.
     *
     * The private key is read here rather than when the handshake arrives, because the key has
     * to be derived inside the link's inbound chain, before the encrypted batch behind the
     * handshake is decoded.
     */
    public async createLogin(relayed: RelayedLogin, auth: IAuthProvider): Promise<Buffer> {
        this.privateKey = await auth.getIdentityPrivateKey();

        const credentials = await auth.createLoginCredentials({
            serverAddress: this.getAddress(),
            protocolVersion: relayed.protocolVersion
        });

        return serialize(
            new LoginPacket({
                protocolVersion: relayed.protocolVersion,
                chainData: credentials.chainData,
                clientData: credentials.clientData
            })
        );
    }

    /** Sends packets to the backend as one batch, and records them. */
    public send(packets: readonly Buffer[], priority: SendPriority = SendPriority.NORMAL): void {
        if (this.closed) return;

        for (const packet of packets) this.options.recorder?.record('serverbound', this.options.role, packet);
        this.link.send(packets, priority);
    }

    /** Closes the connection. The `onClose` callback still runs, once. */
    public close(reason: string): void {
        this.transport.close(reason);
        this.onTransportClosed(reason);
    }

    private onTransportClosed(reason: string): void {
        if (this.closed) return;
        this.closed = true;

        this.options.onClose(reason);
    }

    private onBackendPackets(packets: Buffer[]): void {
        const passed: Buffer[] = [];

        for (const packet of packets) {
            this.options.recorder?.record('clientbound', this.options.role, packet);

            const id = ClientPacketRegistry.readPacketId(packet);

            if (id === PacketIdentifier.SERVER_TO_CLIENT_HANDSHAKE) {
                this.answerHandshake(packet);
                continue;
            }

            if (id === PacketIdentifier.NETWORK_SETTINGS) {
                // Switched here, inside the inbound chain, so the next batch from this backend
                // is already read as compressed.
                this.link.enableCompression(readCompression(packet));
            }

            passed.push(packet);
        }

        if (passed.length > 0) this.options.onPackets(passed);
    }

    private answerHandshake(packet: Buffer): void {
        if (this.privateKey === null) throw new Error('The backend asked for encryption before the login');

        const { jwt } = new ServerToClientHandshakePacket().deserialize(new NetworkBinaryStream(packet));
        const { publicKeyDer, salt } = readHandshake(jwt);

        this.link.enableEncryption(deriveEncryptionKey(this.privateKey, publicKeyDer, salt));
        // Encrypted, like every batch after the handshake.
        this.send([serialize(new ClientToServerHandshakePacket({}))], SendPriority.IMMEDIATE);
    }
}
