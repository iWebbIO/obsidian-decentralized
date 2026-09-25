/**
 * In-memory stand-in for PeerJS 1.5.x: a shared "signalling server" (the network registry
 * below), Peers that register an id on it, and DataConnection pairs that deliver messages to
 * each other asynchronously and in order.
 *
 * Lifecycle details match PeerJS where the plugin depends on them:
 * - destroy() runs disconnect() first, which emits 'disconnected' while `destroyed` is still
 *   false, and then emits 'close'. A 'disconnected' listener that calls reconnect() at that
 *   moment reopens the signalling socket, and destroy() never closes it again — the id stays
 *   held by a dead peer, exactly the zombie that makes the next Peer fail with unavailable-id.
 * - Messages are cloned the way BinaryPack serialisation delivers them: typed-array views
 *   arrive as standalone ArrayBuffers.
 */
import { EventEmitter } from 'events';

class FakeNetwork {
    /** Which peer object currently holds each id on the signalling server. */
    peers = new Map<string, FakePeer>();
    /** Every Peer constructed since the last reset (tests only). */
    created: FakePeer[] = [];
    /** Delivery delay for data messages, in ms. */
    latencyMs = 0;
    /** Pairs of ids that cannot reach each other (tests only). */
    partitions = new Set<string>();

    static pairKey(a: string, b: string) {
        return a < b ? `${a}|${b}` : `${b}|${a}`;
    }
    isPartitioned(a: string, b: string) {
        return this.partitions.has(FakeNetwork.pairKey(a, b));
    }

    reset() {
        this.peers.clear();
        this.created = [];
        this.latencyMs = 0;
        this.partitions.clear();
    }
}

export const __network = new FakeNetwork();

function peerError(message: string, type: string): Error & { type: string } {
    return Object.assign(new Error(message), { type });
}

/** Clone a message the way it arrives on the other side of a real data channel. */
function wireClone(value: any): any {
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) {
        return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    if (Array.isArray(value)) return value.map(wireClone);
    if (value && typeof value === 'object') {
        const out: Record<string, any> = {};
        for (const [key, v] of Object.entries(value)) out[key] = wireClone(v);
        return out;
    }
    return value;
}

export class FakeDataConnection extends EventEmitter {
    /** The REMOTE peer's id, as on a real DataConnection. */
    peer: string;
    provider: FakePeer;
    open = false;
    closed = false;
    reliable: boolean;
    label: string;
    metadata: any;
    serialization = 'binary';
    partner: FakeDataConnection | null = null;
    /** Every message this side sent, as given to send() (tests only). */
    sent: any[] = [];
    dataChannel = {
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        addEventListener() { },
        removeEventListener() { },
    };

    constructor(provider: FakePeer, remoteId: string, options: any = {}) {
        super();
        this.provider = provider;
        this.peer = remoteId;
        this.reliable = !!options.reliable;
        this.label = options.label ?? `dc_${Math.random().toString(36).slice(2, 10)}`;
        this.metadata = options.metadata;
    }

    send(data: any) {
        if (!this.open) {
            this.emit('error', peerError('Connection is not open. You should listen for the `open` event before sending messages.', 'not-open-yet'));
            return;
        }
        this.sent.push(data);
        const partner = this.partner;
        const copy = wireClone(data);
        setTimeout(() => {
            if (partner && partner.open) partner.emit('data', copy);
        }, __network.latencyMs);
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        const wasOpen = this.open;
        this.open = false;
        this.provider.forgetConnection(this);
        // Like PeerJS: a connection that never opened is cleaned up without a 'close' event.
        if (wasOpen) this.emit('close');
        const partner = this.partner;
        if (partner && !partner.closed) setTimeout(() => partner.close(), 0);
    }
}

export default class FakePeer extends EventEmitter {
    id: string;
    options: any;
    open = false;
    disconnected = false;
    destroyed = false;
    /** How many times reconnect() was called (tests only). */
    reconnectCalls = 0;
    connections: FakeDataConnection[] = [];

    constructor(id?: string, options?: any) {
        super();
        this.id = id || `peer-${Math.random().toString(36).slice(2, 10)}`;
        this.options = options;
        __network.created.push(this);
        this.startSocket();
    }

    /** Open the signalling socket: claim the id, then report open (or unavailable-id). */
    private startSocket() {
        const holder = __network.peers.get(this.id);
        const taken = !!holder && holder !== this;
        if (!taken) __network.peers.set(this.id, this);
        setTimeout(() => {
            if (this.destroyed || this.disconnected) return;
            if (taken) {
                // PeerJS _abort(): emit the error, then destroy (no server id was ever assigned).
                this.emit('error', peerError(`ID "${this.id}" is taken`, 'unavailable-id'));
                this.destroy();
                return;
            }
            this.open = true;
            this.emit('open', this.id);
        }, 0);
    }

    private closeSocket() {
        if (__network.peers.get(this.id) === this) __network.peers.delete(this.id);
    }

    /** True when this (possibly destroyed) peer still holds its id on the server (tests only). */
    get holdsId(): boolean {
        return __network.peers.get(this.id) === this;
    }

    connect(remoteId: string, options: any = {}): FakeDataConnection | undefined {
        if (this.disconnected || this.destroyed) return undefined;
        const local = new FakeDataConnection(this, remoteId, options);
        this.connections.push(local);
        setTimeout(() => {
            const remotePeer = __network.peers.get(remoteId);
            if (!remotePeer || remotePeer.destroyed || !remotePeer.open || local.closed || __network.isPartitioned(this.id, remoteId)) {
                this.emit('error', peerError(`Could not connect to peer ${remoteId}`, 'peer-unavailable'));
                return;
            }
            const remote = new FakeDataConnection(remotePeer, this.id, options);
            remotePeer.connections.push(remote);
            local.partner = remote;
            remote.partner = local;
            remotePeer.emit('connection', remote);
            setTimeout(() => {
                if (local.closed || remote.closed) return;
                local.open = true;
                remote.open = true;
                remote.emit('open');
                local.emit('open');
            }, 0);
        }, 0);
        return local;
    }

    forgetConnection(conn: FakeDataConnection) {
        this.connections = this.connections.filter(c => c !== conn);
    }

    disconnect() {
        if (this.disconnected) return;
        this.disconnected = true;
        this.open = false;
        this.closeSocket();
        this.emit('disconnected', this.id);
    }

    reconnect() {
        if (this.destroyed) throw new Error('This peer cannot reconnect to the server. It has already been destroyed.');
        if (!this.disconnected) throw new Error(`Peer ${this.id} cannot reconnect because it is not disconnected from the server!`);
        this.reconnectCalls++;
        this.disconnected = false;
        this.startSocket();
    }

    destroy() {
        if (this.destroyed) return;
        this.disconnect();
        for (const conn of [...this.connections]) conn.close();
        this.connections = [];
        this.destroyed = true;
        this.emit('close');
    }
}

export { FakePeer as Peer, FakeDataConnection as DataConnection };
