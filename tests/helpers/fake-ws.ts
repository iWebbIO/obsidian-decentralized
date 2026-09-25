/**
 * In-memory WebSockets for Offline Mode tests: a `ws`-style server (what DirectIpServer
 * loads on desktop) and a browser-style client (what DirectIpClient uses), linked through a
 * shared registry of listening ports. Frames are delivered asynchronously and in order, and
 * every frame is recorded so tests can inspect exactly what crossed the "network".
 */
import { EventEmitter } from 'events';

export interface WireFrame {
    from: 'client' | 'server';
    text: string | null;
    bytes: Uint8Array;
}

class FakeWsNetwork {
    servers = new Map<number, FakeWsServer>();
    /** Handlers standing in for something other than DirectIpServer (tests only). */
    rawHosts = new Map<number, (socket: FakeServerSocket, request: { url: string }) => void>();
    wire: WireFrame[] = [];
    /** Every client socket ever opened (tests only). */
    clients: FakeBrowserSocket[] = [];

    reset() {
        this.servers.clear();
        this.rawHosts.clear();
        this.wire = [];
        this.clients = [];
    }
}

export const wsNetwork = new FakeWsNetwork();

function record(from: 'client' | 'server', data: any): { payload: any; isBinary: boolean } {
    if (typeof data === 'string') {
        wsNetwork.wire.push({ from, text: data, bytes: new TextEncoder().encode(data) });
        return { payload: data, isBinary: false };
    }
    const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const copy = new Uint8Array(view); // the sender may reuse its buffer
    wsNetwork.wire.push({ from, text: null, bytes: copy });
    return { payload: copy, isBinary: true };
}

/** The host's end of a connection, with the `ws` package's API. */
export class FakeServerSocket extends EventEmitter {
    readyState = 1;
    partner!: FakeBrowserSocket;
    closeCode: number | null = null;
    closeReason = '';

    send(data: any) {
        if (this.readyState !== 1) throw new Error('WebSocket is not open');
        const { payload, isBinary } = record('server', data);
        const partner = this.partner;
        setTimeout(() => {
            if (partner.readyState !== 1) return;
            const delivered = isBinary ? (payload as Uint8Array).slice().buffer : payload;
            partner.onmessage?.({ data: delivered });
        }, 0);
    }

    close(code = 1000, reason = '') {
        if (this.readyState >= 2) return;
        this.closeCode = code;
        this.closeReason = reason;
        this.readyState = 3;
        this.emit('close', code, Buffer.from(reason));
        this.partner.remoteClosed(code, reason);
    }

    remoteClosed(code: number, reason: string) {
        if (this.readyState >= 2) return;
        this.readyState = 3;
        setTimeout(() => this.emit('close', code, Buffer.from(reason)), 0);
    }
}

/** The joining device's end, with the browser WebSocket API. */
export class FakeBrowserSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = 0;
    binaryType = 'blob';
    bufferedAmount = 0;
    url: string;
    partner: FakeServerSocket | null = null;
    onopen: ((ev: any) => void) | null = null;
    onmessage: ((ev: any) => void) | null = null;
    onclose: ((ev: any) => void) | null = null;
    onerror: ((ev: any) => void) | null = null;

    constructor(url: string) {
        // Like browsers: a malformed URL throws synchronously.
        const parsed = new URL(url);
        if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new SyntaxError(`Invalid URL scheme: ${url}`);
        this.url = url;
        wsNetwork.clients.push(this);
        const port = Number(parsed.port || 80);
        const request = { url: parsed.pathname + parsed.search };
        setTimeout(() => {
            if (this.readyState !== 0) return;
            const server = wsNetwork.servers.get(port);
            const raw = wsNetwork.rawHosts.get(port);
            if (!server && !raw) {
                this.readyState = 3;
                this.onerror?.({ type: 'error' });
                this.onclose?.({ code: 1006, reason: '' });
                return;
            }
            const socket = new FakeServerSocket();
            socket.partner = this;
            this.partner = socket;
            this.readyState = 1;
            this.onopen?.({});
            if (server) server.emit('connection', socket, request);
            else raw!(socket, request);
        }, 0);
    }

    send(data: any) {
        if (this.readyState !== 1) throw new Error('WebSocket is not open');
        const { payload, isBinary } = record('client', data);
        const partner = this.partner!;
        setTimeout(() => {
            if (partner.readyState !== 1) return;
            partner.emit('message', isBinary ? Buffer.from(payload as Uint8Array) : Buffer.from(payload as string), isBinary);
        }, 0);
    }

    close(code = 1000, reason = '') {
        if (this.readyState >= 2) return;
        if (this.readyState === 0) {
            this.readyState = 3;
            setTimeout(() => this.onclose?.({ code: 1006, reason: '' }), 0);
            return;
        }
        this.readyState = 2;
        const partner = this.partner;
        setTimeout(() => {
            this.readyState = 3;
            this.onclose?.({ code, reason });
            partner?.remoteClosed(code, reason);
        }, 0);
    }

    remoteClosed(code: number, reason: string) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        setTimeout(() => this.onclose?.({ code, reason }), 0);
    }
}

/** The `ws` package's WebSocketServer. */
export class FakeWsServer extends EventEmitter {
    port: number;

    constructor(options: { port: number }) {
        super();
        this.port = options.port;
        setTimeout(() => {
            if (wsNetwork.servers.has(this.port)) {
                this.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));
                return;
            }
            wsNetwork.servers.set(this.port, this);
            this.emit('listening');
        }, 0);
    }

    close() {
        if (wsNetwork.servers.get(this.port) === this) wsNetwork.servers.delete(this.port);
        this.emit('close');
    }
}

/** What `require('ws')` returns in tests that use these fakes. */
export const wsModule = {
    WebSocketServer: FakeWsServer,
    Server: FakeWsServer,
    WebSocket: FakeServerSocket,
    default: FakeServerSocket,
};
