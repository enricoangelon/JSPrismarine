import { OfflineAuthProvider } from '@jsprismarine/auth';
import { createHash } from 'node:crypto';

import type { ClientDataPayload } from '@jsprismarine/auth';
import type { Login } from '@jsprismarine/protocol';

/**
 * The longest display name a Bedrock Dedicated Server accepts.
 *
 * A longer one is disconnected with an empty reason, so the proxy warns about it itself.
 */
export const MAX_DISPLAY_NAME_LENGTH = 16;

/** What the proxy keeps from a client's login, to log in to the backend in that client's name. */
export interface RelayedLogin {
    readonly protocolVersion: number;
    readonly displayName: string;
    /** The uuid the backend will know the player by. */
    readonly identity: string;
    /** The client's own client data, skin and device fields included. */
    readonly clientData: Partial<ClientDataPayload>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const parseObject = (json: string): Record<string, unknown> | null => {
    try {
        const value: unknown = JSON.parse(json);
        return isRecord(value) ? value : null;
    } catch {
        return null;
    }
};

/** The claims of a JWT, read without checking the signature. */
const readClaims = (token: unknown): Record<string, unknown> | null => {
    if (typeof token !== 'string') return null;

    const payload = token.split('.')[1];
    if (payload === undefined) return null;

    return parseObject(Buffer.from(payload, 'base64url').toString('utf8'));
};

const nonEmptyString = (record: Record<string, unknown> | null, key: string): string | undefined => {
    const value = record?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
};

/**
 * The `extraData` of the certificate chain, when the login has one.
 *
 * Up to 1.26.10 the chain was the whole of `chainData`. From then on it is a JSON string in a
 * `Certificate` field, next to the `Token` that carries the identity. A signed-in client puts
 * its identity in the last link of the chain, so the links are read from the end.
 */
const readExtraData = (chainData: Record<string, unknown>): Record<string, unknown> | null => {
    const certificate = typeof chainData.Certificate === 'string' ? parseObject(chainData.Certificate) : chainData;
    const chain = certificate?.chain;
    if (!Array.isArray(chain)) return null;

    for (const link of chain.toReversed()) {
        const extraData = readClaims(link)?.extraData;
        if (isRecord(extraData)) return extraData;
    }

    return null;
};

/**
 * The uuid an offline player gets from its name, computed the way Java's `nameUUIDFromBytes` does.
 *
 * Only used when a login names no uuid at all. Deriving it from the name keeps it the same
 * across reconnects, so the backend finds the same player data each time.
 */
export const offlineIdentity = (displayName: string): string => {
    const hash = createHash('md5').update(`OfflinePlayer:${displayName}`).digest();
    hash[6] = (hash[6]! & 0x0f) | 0x30;
    hash[8] = (hash[8]! & 0x3f) | 0x80;

    const hex = hash.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Reads who a client says it is out of its `Login`.
 *
 * Nothing is verified. The proxy logs in to an offline backend under its own key, so the
 * client's signatures would protect nothing on that link. The name and uuid are looked for in
 * the certificate chain, then in the token, then in the client data, because which of them a
 * client fills in depends on its version and on whether it is signed in to Xbox Live.
 *
 * @throws When the login names no player anywhere.
 */
export const readRelayedLogin = (login: Login): RelayedLogin => {
    const chainData = parseObject(login.chainData) ?? {};
    const extraData = readExtraData(chainData);
    const token = readClaims(chainData.Token);
    const clientData = readClaims(login.clientData) ?? {};

    const displayName =
        nonEmptyString(extraData, 'displayName') ??
        nonEmptyString(token, 'xname') ??
        nonEmptyString(clientData, 'ThirdPartyName');
    if (displayName === undefined) throw new Error('The login names no player');

    const identity =
        nonEmptyString(extraData, 'identity') ??
        nonEmptyString(token, 'leguuid') ??
        nonEmptyString(clientData, 'SelfSignedId') ??
        offlineIdentity(displayName);

    return {
        protocolVersion: login.protocolVersion,
        displayName,
        identity,
        // Parsed JSON, which the compiler cannot type. The provider overwrites the fields
        // that have to agree with the new login, and copies the rest as the client sent them.
        clientData: clientData as Partial<ClientDataPayload>
    };
};

/**
 * An offline identity that logs in as the relayed client.
 *
 * It has a key of its own, which is the point: the backend completes the encryption handshake
 * against this key, and the proxy holds its private half.
 */
export const createRelayAuth = (relayed: RelayedLogin): OfflineAuthProvider =>
    new OfflineAuthProvider({
        displayName: relayed.displayName,
        identity: relayed.identity,
        clientDataPayload: relayed.clientData
    });
