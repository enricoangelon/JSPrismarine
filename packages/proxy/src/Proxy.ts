import { MINECRAFT_VERSION, PROTOCOL_VERSION } from '@jsprismarine/client';
import { Logger } from '@jsprismarine/logger';
import { ServerName, ServerSocket } from '@jsprismarine/raknet';
import path from 'node:path';
import PacketRecorder from './PacketRecorder';
import ProxySession from './ProxySession';

import type { InetAddress, Protocol, RakNetSession } from '@jsprismarine/raknet';
import type { BackendAddress } from './BackendConnection';

/** How a proxy is set up. */
export interface ProxyOptions {
    /** The address clients connect to. */
    readonly listen: { readonly host: string; readonly port: number };
    /** The server every client is relayed to and plays on. */
    readonly backend: BackendAddress;
    /**
     * A second server that gets the same client packets at the same time, for comparing its
     * answers with the backend's. What it sends is recorded and never reaches the client.
     */
    readonly mirror?: BackendAddress;
    /** A directory to write one NDJSON recording per player into; omit it to record nothing. */
    readonly recordDir?: string;
    /** Shown in the client's server list. */
    readonly motd?: string;
    readonly maxPlayers?: number;
    readonly logger?: Logger;
    /** How long each backend gets to accept a RakNet connection. */
    readonly connectTimeoutMs?: number;
}

const DEFAULT_MOTD = 'JSPrismarine Proxy';
const DEFAULT_MAX_PLAYERS = 20;

/** A recording's file name: when the client connected and from where, safe on every file system. */
const recordingName = (address: InetAddress): string =>
    `${new Date().toISOString().replaceAll(':', '-')}_${address.getAddress()}_${address.getPort()}.ndjson`;

/**
 * A Bedrock proxy that relays every client to one backend and can record the traffic.
 *
 * The client sees the backend's packets unchanged, and the backend sees the client's, apart
 * from the login, which the proxy signs again under an offline identity. That makes it work
 * against JSPrismarine and against a Bedrock Dedicated Server with `online-mode=false`, and
 * the recordings hold what a real client sends, which nothing else in the repository captures.
 *
 * With a mirror, the same client packets also go to a second server, and both servers'
 * answers land in one recording on one clock. Playing on a Bedrock Dedicated Server with
 * JSPrismarine as the mirror shows what each sends in answer to the same input.
 *
 * @example
 * ```typescript
 * const proxy = new Proxy({
 *     listen: { host: '0.0.0.0', port: 19132 },
 *     backend: { host: '127.0.0.1', port: 19133 },
 *     mirror: { host: '127.0.0.1', port: 19134 },
 *     recordDir: 'captures'
 * });
 * proxy.start();
 * ```
 */
export default class Proxy {
    private readonly logger: Logger;
    private readonly sessions = new Map<string, ProxySession>();
    private socket: ServerSocket | null = null;

    public constructor(private readonly options: ProxyOptions) {
        this.logger = options.logger ?? new Logger();
    }

    /** Binds the listening socket and starts accepting clients. */
    public start(): void {
        if (this.socket !== null) throw new Error('The proxy is already running');

        const motd = this.options.motd ?? DEFAULT_MOTD;
        const maxPlayers = this.options.maxPlayers ?? DEFAULT_MAX_PLAYERS;
        const socket = new ServerSocket(
            maxPlayers,
            false,
            new ServerName({
                getConfig: () => ({
                    getMotd: () => motd,
                    getGamemode: () => 'Survival',
                    getMaxPlayers: () => maxPlayers
                }),
                getIdentifiers: () => ({ Protocol: PROTOCOL_VERSION, MinecraftVersions: [MINECRAFT_VERSION] })
            }),
            this.logger
        );

        socket.on('openConnection', (session: RakNetSession) => this.onOpen(session));
        socket.on('encapsulated', (frame: Protocol.Frame, address: InetAddress) => {
            this.sessions.get(address.toToken())?.receiveFromClient(frame.content);
        });
        socket.on('closeConnection', (address: InetAddress, reason?: string) => {
            this.sessions.get(address.toToken())?.onClientClosed(reason ?? 'connection closed');
        });

        const { host, port } = this.options.listen;
        socket.start(host, port);
        this.socket = socket;

        const { backend, mirror } = this.options;
        this.logger.info(
            `Listening on ${host}:${port}, relaying to ${backend.host}:${backend.port}${
                mirror === undefined ? '' : `, mirroring to ${mirror.host}:${mirror.port}`
            }`
        );
    }

    /** Disconnects every player and closes the listening socket. */
    public async close(reason = 'Proxy closed'): Promise<void> {
        await Promise.all(Array.from(this.sessions.values(), (session) => session.close(reason)));
        this.socket?.kill();
        this.socket = null;
    }

    /** How many players are connected. */
    public getSessionCount(): number {
        return this.sessions.size;
    }

    private onOpen(session: RakNetSession): void {
        const address = session.getAddress();
        const token = address.toToken();
        const { backend, mirror, recordDir } = this.options;

        const recorder =
            recordDir === undefined
                ? null
                : PacketRecorder.open(path.join(recordDir, recordingName(address)), {
                      client: token,
                      backend: `${backend.host}:${backend.port}`,
                      mirror: mirror === undefined ? null : `${mirror.host}:${mirror.port}`
                  });

        this.sessions.set(
            token,
            new ProxySession(session, {
                backend,
                mirror,
                logger: this.logger,
                recorder,
                connectTimeoutMs: this.options.connectTimeoutMs,
                onClose: (reason) => {
                    this.sessions.delete(token);
                    this.logger.info(`${token} disconnected: ${reason}`);
                }
            })
        );
        this.logger.info(`${token} connected${recorder === null ? '' : ', recording'}`);
    }
}
