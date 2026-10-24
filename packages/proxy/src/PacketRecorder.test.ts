import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import PacketRecorder, { RECORDING_FORMAT_VERSION } from './PacketRecorder';

const roots: string[] = [];

afterEach(() => {
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const recordingFile = (): string => {
    const root = mkdtempSync(path.join(tmpdir(), 'jsprismarine-recorder-'));
    roots.push(root);
    // A directory that does not exist yet, which the recorder has to create.
    return path.join(root, 'captures', 'session.ndjson');
};

const readLines = (file: string): any[] =>
    readFileSync(file, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));

describe('PacketRecorder', () => {
    it('writes a header line and then one line per packet', async () => {
        const file = recordingFile();
        const recorder = PacketRecorder.open(file, {
            client: '127.0.0.1:50000',
            backend: '127.0.0.1:19133',
            mirror: '127.0.0.1:19134'
        });

        // RequestNetworkSettings (0xc1) needs two header bytes, which is what readPacketId is for.
        const request = Buffer.from([0xc1, 0x01, 0x00, 0x00, 0x08, 0x91]);
        const playStatus = Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00]);
        recorder.record('serverbound', 'primary', request);
        recorder.record('clientbound', 'mirror', playStatus);
        await recorder.close();

        const [header, first, second] = readLines(file);

        expect(header).toMatchObject({
            type: 'session',
            format: RECORDING_FORMAT_VERSION,
            client: '127.0.0.1:50000',
            backend: '127.0.0.1:19133',
            mirror: '127.0.0.1:19134'
        });
        expect(Number.isNaN(Date.parse(header.startedAt))).toBe(false);

        expect(first).toMatchObject({
            type: 'packet',
            direction: 'serverbound',
            id: 0xc1,
            name: 'REQUEST_NETWORK_SETTINGS',
            size: 6
        });
        expect(Buffer.from(first.payload, 'base64')).toEqual(request);

        expect(second).toMatchObject({ direction: 'clientbound', backend: 'mirror', id: 0x02, name: 'PLAY_STATUS' });
        expect(second.t).toBeGreaterThanOrEqual(first.t);
    });

    it('names an id the protocol package does not know as null', async () => {
        const file = recordingFile();
        const recorder = PacketRecorder.open(file, { client: 'a:1', backend: 'b:2', mirror: null });

        recorder.record('clientbound', 'primary', Buffer.from([0x7f]));
        await recorder.close();

        expect(readLines(file)[1]).toMatchObject({ id: 0x7f, name: null });
    });

    it('ignores packets recorded after it was closed', async () => {
        const file = recordingFile();
        const recorder = PacketRecorder.open(file, { client: 'a:1', backend: 'b:2', mirror: null });
        await recorder.close();

        expect(() => recorder.record('clientbound', 'primary', Buffer.from([0x02]))).not.toThrow();
        await recorder.close();

        expect(readLines(file)).toHaveLength(1);
    });
});
