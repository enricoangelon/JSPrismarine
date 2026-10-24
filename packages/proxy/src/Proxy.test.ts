import { OfflineAuthProvider } from '@jsprismarine/auth';
import { Client } from '@jsprismarine/client';
import { Logger } from '@jsprismarine/logger';
import { Config, Server } from '@jsprismarine/prismarine';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PacketIdentifier } from '@jsprismarine/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Proxy from './Proxy';
import { startFakeBackend } from './testing/fakeBackend.test.helper';

import type { FakeBackend } from './testing/fakeBackend.test.helper';

/**
 * The proxy between a real server and a real client, both in this process.
 *
 * JSPrismarine never asks for encryption, so this covers compression, the re-signed login and
 * forwarding, but not the encryption handshake. That part needs a Bedrock Dedicated Server.
 * The mirror tests use a fake backend that does encrypt.
 */

const SERVER_PORT = 19290;
const PROXY_PORT = 19291;
const MIRROR_PORT = 19296;
const MIRRORING_PROXY_PORT = 19297;

let stateRoot: string;
let recordDir: string;
let mirrorRecordDir: string;
let server: Server | null = null;
let proxy: Proxy | null = null;
let mirroringProxy: Proxy | null = null;
let mirror: FakeBackend | null = null;

beforeAll(async () => {
    // Pointed at a temp directory so the run writes no world, config or log into the repo.
    stateRoot = mkdtempSync(path.join(tmpdir(), 'jsprismarine-proxy-'));
    recordDir = path.join(stateRoot, 'captures');
    mirrorRecordDir = path.join(stateRoot, 'mirror-captures');
    vi.stubEnv('JSP_DIR', stateRoot);

    const logger = new Logger('error');
    server = new Server({ logger, config: new Config(), headless: true });
    await server.bootstrap('127.0.0.1', SERVER_PORT);

    proxy = new Proxy({
        listen: { host: '127.0.0.1', port: PROXY_PORT },
        backend: { host: '127.0.0.1', port: SERVER_PORT },
        recordDir,
        logger
    });
    proxy.start();

    mirror = startFakeBackend({ port: MIRROR_PORT, logger, encrypt: true });
    mirroringProxy = new Proxy({
        listen: { host: '127.0.0.1', port: MIRRORING_PROXY_PORT },
        backend: { host: '127.0.0.1', port: SERVER_PORT },
        mirror: { host: '127.0.0.1', port: MIRROR_PORT },
        recordDir: mirrorRecordDir,
        logger
    });
    mirroringProxy.start();
}, 60_000);

afterAll(async () => {
    await proxy?.close();
    await mirroringProxy?.close();
    mirror?.kill();
    server?.getRaknet()?.kill();
    vi.unstubAllEnvs();
    rmSync(stateRoot, { recursive: true, force: true });
}, 30_000);

const readRecording = (directory = recordDir): any[] => {
    const [file] = readdirSync(directory);
    expect(file).toBeDefined();

    return readFileSync(path.join(directory, file!), 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
};

describe('relaying a client through the proxy', () => {
    it('spawns the client on the backend under its own name and records the session', async () => {
        const auth = new OfflineAuthProvider({ displayName: 'ProxyTester' });
        const identity = await auth.getIdentity();
        const client = new Client({
            host: '127.0.0.1',
            port: PROXY_PORT,
            logger: new Logger('error'),
            auth,
            loginTimeoutMs: 25_000
        });

        try {
            const startGame = await client.connect();
            expect(startGame.runtimeEntityId).toBeGreaterThan(0n);

            const player = server!
                .getSessionManager()
                .getAllPlayers()
                .find((candidate) => candidate.getName() === 'ProxyTester');
            expect(player).toBeDefined();
            // The proxy signed the backend login with a key of its own, and kept the uuid.
            expect(player!.getUUID().toString()).toBe(identity.identity);
        } finally {
            client.disconnect();
        }

        // The backend connection is closed once the client has gone.
        await vi.waitFor(() => expect(proxy!.getSessionCount()).toBe(0), { timeout: 15_000 });
        // The recorder is closed with the session, and its stream finishes writing shortly after.
        const [header, ...packets] = await vi.waitFor(() => {
            const lines = readRecording();
            expect(lines.some((line) => line.name === 'SET_LOCAL_PLAYER_AS_INITIALIZED')).toBe(true);
            return lines;
        });
        expect(header).toMatchObject({ type: 'session', backend: `127.0.0.1:${SERVER_PORT}` });

        const sent = (direction: string) =>
            packets.filter((packet) => packet.direction === direction).map((packet) => packet.name);

        expect(sent('serverbound').slice(0, 2)).toEqual(['REQUEST_NETWORK_SETTINGS', 'LOGIN']);
        expect(sent('serverbound')).toContain('SET_LOCAL_PLAYER_AS_INITIALIZED');
        expect(sent('clientbound')[0]).toBe('NETWORK_SETTINGS');
        expect(sent('clientbound')).toEqual(expect.arrayContaining(['PLAY_STATUS', 'START_GAME']));
    }, 60_000);
});

describe('mirroring a client to a second backend', () => {
    it('sends the mirror the same client packets, records both, and keeps the mirror away from the client', async () => {
        const client = new Client({
            host: '127.0.0.1',
            port: MIRRORING_PROXY_PORT,
            logger: new Logger('error'),
            auth: new OfflineAuthProvider({ displayName: 'MirrorTester' }),
            loginTimeoutMs: 25_000
        });

        try {
            // The client spawns on the primary even though the mirror never sends StartGame.
            await client.connect();

            // The mirror asked for encryption on its own link, and got everything the client sent.
            await vi.waitFor(() =>
                expect(mirror!.received).toContain(PacketIdentifier.SET_LOCAL_PLAYER_AS_INITIALIZED)
            );
            expect(mirror!.received.slice(0, 3)).toEqual([
                PacketIdentifier.REQUEST_NETWORK_SETTINGS,
                PacketIdentifier.LOGIN,
                PacketIdentifier.CLIENT_TO_SERVER_HANDSHAKE
            ]);
            expect(mirror!.received).toEqual(
                expect.arrayContaining([
                    PacketIdentifier.RESOURCE_PACK_CLIENT_RESPONSE,
                    PacketIdentifier.REQUEST_CHUNK_RADIUS
                ])
            );

            // Losing the mirror does not cost the player the game.
            mirror!.dropAll();
            await new Promise((resolve) => setTimeout(resolve, 500));
            expect(client.isConnected()).toBe(true);
            expect(mirroringProxy!.getSessionCount()).toBe(1);
        } finally {
            client.disconnect();
        }

        await vi.waitFor(() => expect(mirroringProxy!.getSessionCount()).toBe(0), { timeout: 15_000 });

        const [header, ...packets] = await vi.waitFor(() => {
            const lines = readRecording(mirrorRecordDir);
            expect(
                lines.some((line) => line.backend === 'mirror' && line.name === 'SET_LOCAL_PLAYER_AS_INITIALIZED')
            ).toBe(true);
            return lines;
        });
        expect(header).toMatchObject({ backend: `127.0.0.1:${SERVER_PORT}`, mirror: `127.0.0.1:${MIRROR_PORT}` });

        const names = (backend: string, direction: string) =>
            packets
                .filter((packet) => packet.backend === backend && packet.direction === direction)
                .map((packet) => packet.name);

        expect(names('primary', 'clientbound')).toContain('START_GAME');
        // What the mirror answered is on record, including the handshake the client never saw.
        expect(names('mirror', 'clientbound')).toEqual(['NETWORK_SETTINGS', 'SERVER_TO_CLIENT_HANDSHAKE']);
        expect(names('mirror', 'serverbound')).toContain('SET_LOCAL_PLAYER_AS_INITIALIZED');
    }, 60_000);
});
