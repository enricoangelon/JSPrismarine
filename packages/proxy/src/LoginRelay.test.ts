import { OfflineAuthProvider } from '@jsprismarine/auth';
import { describe, expect, it } from 'vitest';
import { createRelayAuth, offlineIdentity, readRelayedLogin } from './LoginRelay';

/** A JWT with the given claims. The relay never checks signatures, so this one has none. */
const unsignedJwt = (claims: Record<string, unknown>): string =>
    [{ alg: 'none' }, claims].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.';

const claimsOf = (token: string): Record<string, any> =>
    JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));

const REQUEST = { serverAddress: '127.0.0.1:19132', protocolVersion: 2193 };

describe('reading a relayed login', () => {
    it('reads the identity from the token a 1.26.10+ offline client sends', async () => {
        const auth = new OfflineAuthProvider({
            displayName: 'Steve',
            identity: '11111111-2222-3333-4444-555555555555'
        });
        const credentials = await auth.createLoginCredentials(REQUEST);

        const relayed = readRelayedLogin({ protocolVersion: 2193, ...credentials });

        expect(relayed.protocolVersion).toBe(2193);
        expect(relayed.displayName).toBe('Steve');
        expect(relayed.identity).toBe('11111111-2222-3333-4444-555555555555');
        expect(relayed.clientData.SkinId).toBe('JSPrismarine-Default');
    });

    it('reads the identity from the extraData of an older certificate chain', async () => {
        const auth = new OfflineAuthProvider({ displayName: 'Alex', identity: '66666666-7777-8888-9999-000000000000' });
        const credentials = await auth.createLoginCredentials({ ...REQUEST, protocolVersion: 748 });

        const relayed = readRelayedLogin({ protocolVersion: 748, ...credentials });

        expect(relayed.displayName).toBe('Alex');
        expect(relayed.identity).toBe('66666666-7777-8888-9999-000000000000');
    });

    it("prefers the chain's last link, where a signed-in client keeps its identity", () => {
        const chain = [
            unsignedJwt({ certificateAuthority: true }),
            unsignedJwt({ extraData: { displayName: 'Signed', identity: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } })
        ];

        const relayed = readRelayedLogin({
            protocolVersion: 2193,
            chainData: JSON.stringify({
                AuthenticationType: 0,
                Certificate: JSON.stringify({ chain }),
                Token: unsignedJwt({ xname: 'FromToken' })
            }),
            clientData: unsignedJwt({ SkinId: 'persona' })
        });

        expect(relayed.displayName).toBe('Signed');
        expect(relayed.identity).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        expect(relayed.clientData.SkinId).toBe('persona');
    });

    it('derives a stable uuid from the name when the login carries none', () => {
        const login = {
            protocolVersion: 2193,
            chainData: JSON.stringify({ Certificate: JSON.stringify({ chain: [''] }), Token: '' }),
            clientData: unsignedJwt({ ThirdPartyName: 'Nameless' })
        };

        const relayed = readRelayedLogin(login);

        expect(relayed.displayName).toBe('Nameless');
        expect(relayed.identity).toBe(offlineIdentity('Nameless'));
        expect(readRelayedLogin(login).identity).toBe(relayed.identity);
        // Version 3, variant 1: the shape of a name-based uuid.
        expect(relayed.identity).toMatch(/^[\da-f]{8}-[\da-f]{4}-3[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    });

    it('refuses a login that names no player', () => {
        expect(() => readRelayedLogin({ protocolVersion: 2193, chainData: '{}', clientData: unsignedJwt({}) })).toThrow(
            'names no player'
        );
    });
});

describe('signing the relayed login again', () => {
    it("keeps the client's name, uuid and skin under a key of the proxy's own", async () => {
        const client = new OfflineAuthProvider({ displayName: 'Steve', clientData: { skinId: 'relayed-skin' } });
        const original = await client.createLoginCredentials(REQUEST);
        const relayed = readRelayedLogin({ protocolVersion: 2193, ...original });

        const auth = createRelayAuth(relayed);
        const credentials = await auth.createLoginCredentials({ ...REQUEST, serverAddress: 'backend.example:19133' });

        const token = claimsOf(JSON.parse(credentials.chainData).Token);
        expect(token.xname).toBe('Steve');
        expect(token.leguuid).toBe(relayed.identity);
        // The backend encrypts against this key, so it has to be one the proxy holds.
        expect(token.cpk).toBe(await auth.getIdentityPublicKey());
        expect(token.cpk).not.toBe(await client.getIdentityPublicKey());

        const clientData = claimsOf(credentials.clientData);
        expect(clientData.SkinId).toBe('relayed-skin');
        expect(clientData.ServerAddress).toBe('backend.example:19133');
    });
});
