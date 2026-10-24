import { SendPriority } from '@jsprismarine/client';
import { BatchCodec, EncryptionCodec } from '@jsprismarine/protocol';

import type { Logger } from '@jsprismarine/logger';
import type { CompressionSettings } from '@jsprismarine/protocol';

/** Sends one framed batch on the connection under a link. */
export type BatchSink = (payload: Buffer, priority: SendPriority) => void;

/** Receives the packets of one batch, header included, in the order the batch held them. */
export type PacketSink = (packets: Buffer[]) => void;

/**
 * One side of the proxy: a connection's batches in, its packets out, and the reverse.
 *
 * The proxy has two of these per player, one facing the client and one facing the backend,
 * and each negotiates compression and encryption on its own. Both directions run through a
 * promise chain, because compression is asynchronous and a large batch would otherwise be
 * overtaken by the small ones behind it.
 *
 * The packet sink is called synchronously from inside the inbound chain. A caller that enables
 * compression or encryption from the sink therefore does so before the next batch is decoded,
 * which is what the protocol requires: the batch after `NetworkSettings` is compressed and the
 * batch after `ServerToClientHandshake` is encrypted.
 */
export default class Link {
    private codec = BatchCodec.uncompressed();
    private encryption: EncryptionCodec | null = null;
    private inbound: Promise<void> = Promise.resolve();
    private outbound: Promise<void> = Promise.resolve();

    /**
     * @param name - which side this is, for log lines.
     */
    public constructor(
        private readonly name: string,
        private readonly sink: BatchSink,
        private readonly onPackets: PacketSink,
        private readonly logger: Logger
    ) {}

    /** Compresses every batch sent or received after this call. */
    public enableCompression(settings: CompressionSettings): void {
        this.codec = BatchCodec.compressed(settings);
    }

    /**
     * Encrypts every batch sent or received after this call.
     * @param key - the 32 byte key both ends derived from the handshake.
     */
    public enableEncryption(key: Buffer): void {
        this.encryption = new EncryptionCodec(key);
    }

    /** Queues one batch that arrived on the connection for decoding. */
    public receive(payload: Buffer): void {
        this.inbound = this.inbound.then(() => this.decode(payload));
    }

    /**
     * Sends packets as one batch.
     *
     * The codec and the encryption are the ones in force when this is called, not when the
     * batch is finally written, so a packet queued before compression was enabled still goes
     * out uncompressed.
     */
    public send(packets: readonly Buffer[], priority: SendPriority = SendPriority.NORMAL): void {
        if (packets.length === 0) return;

        const encryption = this.encryption;
        const encoded = this.codec.encodeAsync(packets);

        this.outbound = this.outbound
            .then(async () => {
                const batch = await encoded;
                this.sink(encryption?.encrypt(batch) ?? batch, priority);
            })
            .catch((error: unknown) => {
                this.logger.error(`Failed to send a batch to the ${this.name}: ${describe(error)}`);
            });
    }

    /** Resolves once every batch already passed to {@link send} has been handed to the connection. */
    public async flush(): Promise<void> {
        await this.outbound;
    }

    private async decode(payload: Buffer): Promise<void> {
        let packets: Buffer[];

        try {
            packets = await this.codec.decodeAsync(this.encryption?.decrypt(payload) ?? payload);
        } catch (error: unknown) {
            this.logger.error(
                `Failed to decode a batch of ${payload.byteLength} bytes from the ${this.name}: ${describe(error)}`
            );
            return;
        }

        try {
            this.onPackets(packets);
        } catch (error: unknown) {
            this.logger.error(`Failed to handle a batch from the ${this.name}: ${describe(error)}`);
        }
    }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
