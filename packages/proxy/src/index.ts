import { MAX_DISPLAY_NAME_LENGTH, createRelayAuth, offlineIdentity, readRelayedLogin } from './LoginRelay';
import Link from './Link';
import PacketRecorder, { RECORDING_FORMAT_VERSION } from './PacketRecorder';
import Proxy from './Proxy';
import ProxySession from './ProxySession';

export {
    Link,
    MAX_DISPLAY_NAME_LENGTH,
    PacketRecorder,
    Proxy,
    ProxySession,
    RECORDING_FORMAT_VERSION,
    createRelayAuth,
    offlineIdentity,
    readRelayedLogin
};

export default Proxy;

export type { BatchSink, PacketSink } from './Link';
export type { RelayedLogin } from './LoginRelay';
export type { PacketDirection, RecordedPacket, RecordingHeader } from './PacketRecorder';
export type { ProxyOptions } from './Proxy';
export type { BackendAddress, ProxySessionOptions } from './ProxySession';
