import { ClientPacketRegistry } from '@jsprismarine/client';
import { PacketIdentifier } from '@jsprismarine/protocol';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import type { WriteStream } from 'node:fs';

/** Which way a recorded packet went. Serverbound is toward the backend. */
export type PacketDirection = 'serverbound' | 'clientbound';

/**
 * Which backend a recorded packet was exchanged with: the one the client plays on, or the
 * mirror that gets the same client packets for comparison.
 */
export type BackendRole = 'primary' | 'mirror';

/** Bumped whenever a field of a recorded line changes meaning. 2 added the backend role. */
export const RECORDING_FORMAT_VERSION = 2;

/** The first line of a recording. */
export interface RecordingHeader {
    readonly type: 'session';
    readonly format: number;
    /** When the client connected, as an ISO 8601 timestamp. */
    readonly startedAt: string;
    /** The client's address, `host:port`. */
    readonly client: string;
    /** The primary backend's address, `host:port`. */
    readonly backend: string;
    /** The mirror's address, `host:port`, or null when nothing was mirrored. */
    readonly mirror: string | null;
}

/** Every line after the header: one packet. */
export interface RecordedPacket {
    readonly type: 'packet';
    /** Milliseconds since the recording started. */
    readonly t: number;
    readonly direction: PacketDirection;
    readonly backend: BackendRole;
    readonly id: number;
    /** The `PacketIdentifier` name, or null for an id the protocol package does not name yet. */
    readonly name: string | null;
    /** Byte length of the packet, header included. */
    readonly size: number;
    /** The packet as it crossed the wire, header included, in base64. */
    readonly payload: string;
}

/**
 * Writes one player's conversation with the backends to an NDJSON file.
 *
 * It records what each backend sent and received, which is what a replay needs: the login is
 * the one the proxy signed, and the encryption handshake that the client never sees is in it.
 * Payloads are decompressed and decrypted but otherwise exactly as they were on the wire. Both
 * backends share one clock, so `t` says what each of them sent at the same moment.
 *
 * @example
 * ```typescript
 * const recorder = PacketRecorder.open('captures/session.ndjson', {
 *     client: '127.0.0.1:50123',
 *     backend: '127.0.0.1:19133',
 *     mirror: '127.0.0.1:19134'
 * });
 * recorder.record('serverbound', 'primary', packet);
 * await recorder.close();
 * ```
 */
export default class PacketRecorder {
    private readonly startedAt = performance.now();
    private closed = false;

    private constructor(private readonly stream: WriteStream) {}

    /**
     * Creates the file, and any missing parent directory, and writes the header line.
     *
     * Synchronous, so a recorder exists before the first packet does: the stream buffers
     * whatever is recorded while the file is still opening.
     * @param file - where to write; an existing file is replaced.
     */
    public static open(file: string, session: Pick<RecordingHeader, 'client' | 'backend' | 'mirror'>): PacketRecorder {
        mkdirSync(path.dirname(file), { recursive: true });

        const recorder = new PacketRecorder(createWriteStream(file));
        recorder.write({
            type: 'session',
            format: RECORDING_FORMAT_VERSION,
            startedAt: new Date().toISOString(),
            ...session
        } satisfies RecordingHeader);

        return recorder;
    }

    /** Appends one packet, header included. Ignored once the recorder is closed. */
    public record(direction: PacketDirection, backend: BackendRole, packet: Buffer): void {
        if (this.closed) return;

        const id = ClientPacketRegistry.readPacketId(packet);

        this.write({
            type: 'packet',
            t: Math.round((performance.now() - this.startedAt) * 1000) / 1000,
            direction,
            backend,
            id,
            name: PacketIdentifier[id] ?? null,
            size: packet.byteLength,
            payload: packet.toString('base64')
        } satisfies RecordedPacket);
    }

    /** Resolves once every line has reached the file. */
    public async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;

        await new Promise<void>((resolve, reject) => {
            this.stream.once('error', reject);
            this.stream.end(resolve);
        });
    }

    private write(line: RecordingHeader | RecordedPacket): void {
        this.stream.write(`${JSON.stringify(line)}\n`);
    }
}
