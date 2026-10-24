import { ClientPacketRegistry, SendPriority } from '@jsprismarine/client';
import { DisconnectPacket, LoginPacket, NetworkBinaryStream, PacketIdentifier } from '@jsprismarine/protocol';
import { ConnectionPriority, Protocol } from '@jsprismarine/raknet';
import BackendConnection, { readCompression } from './BackendConnection';
import Link from './Link';
import { MAX_DISPLAY_NAME_LENGTH, createRelayAuth, readRelayedLogin } from './LoginRelay';

import type { Logger } from '@jsprismarine/logger';
import type { RakNetSession } from '@jsprismarine/raknet';
import type { BackendAddress } from './BackendConnection';
import type { BackendRole } from './PacketRecorder';
import type PacketRecorder from './PacketRecorder';

/** What a session needs from the proxy that owns it. */
export interface ProxySessionOptions {
    /** The server the client plays on. */
    readonly backend: BackendAddress;
    /**
     * A second server that gets the same client packets, for comparing with the first. What it
     * sends back is recorded and never reaches the client.
     */
    readonly mirror?: BackendAddress;
    readonly logger: Logger;
    /** Receives every packet exchanged with either backend; null records nothing. */
    readonly recorder: PacketRecorder | null;
    /** How long each backend gets to accept the RakNet connection. */
    readonly connectTimeoutMs?: number;
    /** Called once, after every connection is closed. */
    readonly onClose?: (reason: string) => void;
}

/** The DisconnectPacket reason the proxy sends when the backend could not be reached. */
const DISCONNECT_REASON_UNKNOWN = 0;

/**
 * One player passing through the proxy: the connection from the client, the one to the backend
 * it plays on, and optionally one to a mirror.
 *
 * Everything is forwarded as it arrived, batch for batch, apart from the steps each connection
 * has to negotiate on its own:
 *
 * - `RequestNetworkSettings` from the client opens the backend connections, and goes on to each
 *   of them unchanged. The primary backend's `NetworkSettings` goes back to the client
 *   unchanged, and the client link switches to the compression it names.
 * - `Login` is signed again, by an offline identity carrying the client's name, uuid and
 *   client data. The proxy cannot reuse the client's signature: a backend encrypts against the
 *   key in the login, and only the client holds that key's private half.
 * - `ServerToClientHandshake` is answered by the proxy and not forwarded. The client link
 *   stays unencrypted, which the client accepts from any server that does not ask for it.
 *
 * The mirror is best effort. If it cannot be reached or drops out, the player keeps playing on
 * the primary backend and the proxy logs why.
 */
export default class ProxySession {
    private readonly client: Link;
    private primary: BackendConnection | null = null;
    private mirror: BackendConnection | null = null;

    /** Serverbound batches, one after another, because opening backends and signing logins are asynchronous. */
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

    /** Closes the backend connections after the client has gone. */
    public onClientClosed(reason: string): void {
        this.finish(`client left: ${reason}`);
    }

    /**
     * Ends every connection.
     *
     * The client is sent a `Disconnect` carrying the reason, because a RakNet disconnect on its
     * own leaves the game showing a generic message that says nothing about the backend.
     */
    public async close(reason: string): Promise<void> {
        if (this.closing || this.closed) return;
        this.closing = true;

        if (!this.disconnectForwarded) {
            const disconnect = new DisconnectPacket({
                reason: DISCONNECT_REASON_UNKNOWN,
                skipMessage: false,
                message: reason
            });
            this.client.send([disconnect.serialize(new NetworkBinaryStream())], SendPriority.IMMEDIATE);
        }
        await this.client.flush();

        this.session.disconnect(reason);
        this.finish(reason);
    }

    private finish(reason: string): void {
        if (this.closed) return;
        this.closed = true;

        this.primary?.close(reason);
        this.mirror?.close(reason);
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
            .then(() => this.forwardToBackends(packets))
            .catch(async (error: unknown) => {
                await this.close(`Proxy error: ${error instanceof Error ? error.message : String(error)}`);
            });
    }

    private async forwardToBackends(packets: Buffer[]): Promise<void> {
        if (this.closed) return;

        // Built per backend, because each one gets a login signed for its own address.
        const toPrimary: Buffer[] = [];
        const toMirror: Buffer[] = [];

        for (const packet of packets) {
            const id = ClientPacketRegistry.readPacketId(packet);

            if (id === PacketIdentifier.REQUEST_NETWORK_SETTINGS && this.primary === null) {
                await this.connectBackends();
            }

            if (id === PacketIdentifier.LOGIN) {
                const [forPrimary, forMirror] = await this.relayLogin(packet);
                toPrimary.push(forPrimary);
                if (forMirror !== null) toMirror.push(forMirror);
            } else {
                toPrimary.push(packet);
                toMirror.push(packet);
            }
        }

        if (this.primary === null) throw new Error('The client did not start with RequestNetworkSettings');

        this.primary.send(toPrimary);
        this.mirror?.send(toMirror);
    }

    private async connectBackends(): Promise<void> {
        const primary = this.createConnection('primary', this.options.backend);
        const mirror = this.options.mirror === undefined ? null : this.createConnection('mirror', this.options.mirror);

        const [primaryResult, mirrorResult] = await Promise.allSettled([primary.connect(), mirror?.connect()]);

        if (primaryResult.status === 'rejected') {
            mirror?.close('the primary backend is unreachable');
            throw primaryResult.reason;
        }
        this.primary = primary;

        if (mirror === null) return;
        if (mirrorResult.status === 'rejected') {
            this.options.logger.warn(
                `${mirrorResult.reason instanceof Error ? mirrorResult.reason.message : String(mirrorResult.reason)}; continuing without a mirror`
            );
            mirror.close('unreachable');
            return;
        }
        this.mirror = mirror;
    }

    private createConnection(role: BackendRole, address: BackendAddress): BackendConnection {
        return new BackendConnection({
            role,
            address,
            logger: this.options.logger,
            recorder: this.options.recorder,
            connectTimeoutMs: this.options.connectTimeoutMs,
            onPackets: role === 'primary' ? (packets) => this.forwardToClient(packets) : () => {},
            onClose: (reason) => this.onBackendClosed(role, reason)
        });
    }

    private onBackendClosed(role: BackendRole, reason: string): void {
        if (role === 'primary') {
            void this.close(`The backend closed the connection: ${reason}`);
            return;
        }

        if (this.closed) return;
        this.mirror = null;
        this.options.logger.warn(`The mirror closed the connection (${reason}); continuing without it`);
    }

    private async relayLogin(packet: Buffer): Promise<[Buffer, Buffer | null]> {
        const relayed = readRelayedLogin(new LoginPacket().deserialize(new NetworkBinaryStream(packet)));

        if (relayed.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
            this.options.logger.warn(
                `${relayed.displayName} is longer than ${MAX_DISPLAY_NAME_LENGTH} characters, which a Bedrock Dedicated Server refuses with an empty reason`
            );
        }

        const primary = this.primary;
        if (primary === null) throw new Error('The client logged in before RequestNetworkSettings');

        // One identity for both backends, so both know the player by the same uuid.
        const auth = createRelayAuth(relayed);
        const forPrimary = await primary.createLogin(relayed, auth);
        const forMirror = (await this.mirror?.createLogin(relayed, auth)) ?? null;

        this.options.logger.info(
            `Relaying ${relayed.displayName} to ${primary.getAddress()}${
                this.mirror === null ? '' : `, mirrored to ${this.mirror.getAddress()}`
            }`
        );

        return [forPrimary, forMirror];
    }

    private forwardToClient(packets: Buffer[]): void {
        let forwarded: Buffer[] = [];

        for (const packet of packets) {
            const id = ClientPacketRegistry.readPacketId(packet);

            if (id === PacketIdentifier.NETWORK_SETTINGS) {
                // Sent before the client link switches over, because NetworkSettings itself
                // travels uncompressed and the client expects compression from the next batch.
                this.client.send([...forwarded, packet], SendPriority.IMMEDIATE);
                forwarded = [];
                this.client.enableCompression(readCompression(packet));
                continue;
            }

            if (id === PacketIdentifier.DISCONNECT) this.disconnectForwarded = true;
            forwarded.push(packet);
        }

        this.client.send(forwarded);
    }
}
