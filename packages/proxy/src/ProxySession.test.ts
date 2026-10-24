import { OfflineAuthProvider } from '@jsprismarine/auth';
import { Client } from '@jsprismarine/client';
import { Logger } from '@jsprismarine/logger';
import { PacketIdentifier } from '@jsprismarine/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Proxy from './Proxy';
import { startFakeBackend } from './testing/fakeBackend.test.helper';

import type { FakeBackend } from './testing/fakeBackend.test.helper';

const BACKEND_PORT = 19292;
const PROXY_PORT = 19293;
const UNREACHABLE_PROXY_PORT = 19294;
const SECRET_MESSAGE = 'decrypted by the proxy';

const logger = new Logger('error');

const newClient = (port: number, displayName: string) =>
    new Client({
        host: '127.0.0.1',
        port,
        logger,
        auth: new OfflineAuthProvider({ displayName }),
        loginTimeoutMs: 15_000
    });

/**
 * A backend that asks for encryption, which JSPrismarine does not.
 *
 * Once it has decrypted the proxy's `ClientToServerHandshake` it sends an encrypted
 * `Disconnect`, so the client seeing that message proves both directions worked.
 */
describe('a backend that asks for encryption', () => {
    let backend: FakeBackend | null = null;
    let proxy: Proxy | null = null;

    beforeAll(() => {
        backend = startFakeBackend({
            port: BACKEND_PORT,
            logger,
            encrypt: true,
            disconnectAfterHandshake: SECRET_MESSAGE
        });
        proxy = new Proxy({
            listen: { host: '127.0.0.1', port: PROXY_PORT },
            backend: { host: '127.0.0.1', port: BACKEND_PORT },
            logger
        });
        proxy.start();
    });

    afterAll(async () => {
        await proxy?.close();
        backend?.kill();
    });

    it('gets its handshake answered by the proxy, and its encrypted packets reach the client', async () => {
        await expect(newClient(PROXY_PORT, 'Encrypted').connect()).rejects.toThrow(SECRET_MESSAGE);

        // The handshake reply was decrypted by the backend, so the proxy encrypted it with the right key.
        expect(backend!.received).toEqual([
            PacketIdentifier.REQUEST_NETWORK_SETTINGS,
            PacketIdentifier.LOGIN,
            PacketIdentifier.CLIENT_TO_SERVER_HANDSHAKE
        ]);
    }, 30_000);
});

describe('a backend that is not there', () => {
    it('tells the client why, instead of leaving it to time out', async () => {
        const unreachable = new Proxy({
            listen: { host: '127.0.0.1', port: UNREACHABLE_PROXY_PORT },
            // Nothing listens here.
            backend: { host: '127.0.0.1', port: UNREACHABLE_PROXY_PORT + 1 },
            logger,
            connectTimeoutMs: 1000
        });
        unreachable.start();

        try {
            await expect(newClient(UNREACHABLE_PROXY_PORT, 'Stranded').connect()).rejects.toThrow(
                'Cannot reach the primary backend at 127.0.0.1:19295'
            );
        } finally {
            await unreachable.close();
        }
    }, 30_000);
});
