import { OfflineAuthProvider } from '@jsprismarine/auth';
import { Client } from '@jsprismarine/client';
import { Logger } from '@jsprismarine/logger';
import { Config, Server } from '@jsprismarine/prismarine';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Proxy from './Proxy';

/**
 * The proxy between a real server and a real client, both in this process.
 *
 * JSPrismarine never asks for encryption, so this covers compression, the re-signed login and
 * forwarding, but not the encryption handshake. That part needs a Bedrock Dedicated Server.
 */

const SERVER_PORT = 19290;
const PROXY_PORT = 19291;

let stateRoot: string;
let recordDir: string;
let server: Server | null = null;
let proxy: Proxy | null = null;

beforeAll(async () => {
    // Pointed at a temp directory so the run writes no world, config or log into the repo.
    stateRoot = mkdtempSync(path.join(tmpdir(), 'jsprismarine-proxy-'));
    recordDir = path.join(stateRoot, 'captures');
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
}, 60_000);

afterAll(async () => {
    await proxy?.close();
    server?.getRaknet()?.kill();
    vi.unstubAllEnvs();
    rmSync(stateRoot, { recursive: true, force: true });
}, 30_000);

const readRecording = (): any[] => {
    const [file] = readdirSync(recordDir);
    expect(file).toBeDefined();

    return readFileSync(path.join(recordDir, file!), 'utf8')
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
