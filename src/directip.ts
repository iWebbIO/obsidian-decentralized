import { Platform } from 'obsidian';
import { DirectIpConfig } from './types';
import { splitBinaryPayload, joinBinaryPayload, packFrame, unpackFrame } from './utils';
import {
    AUTH_CHALLENGE,
    AUTH_OK,
    AUTH_PROOF,
    DIRECT_IP_AUTH_VERSION,
    base64ToBytes,
    bytesToBase64,
    clientProof,
    deriveSessionKeys,
    hostProof,
    openFrame,
    proofsMatch,
    randomNonce,
    sealFrame,
} from './utils/direct-ip-auth';
import { formatHostForUrl } from './utils/net';
import type ObsidianDecentralizedPlugin from './main';
import { loadWs } from './ws-loader';

// Heartbeat constants (mirror main.ts startHeartbeat)
const HEARTBEAT_INTERVAL_MS = 5000;   // ping every 5 s
const LIVENESS_TIMEOUT_MS   = 20000;  // declare dead after 20 s of silence
/** How long either side waits for the other half of the authentication exchange. */
const AUTH_TIMEOUT_MS = 10000;
/** WebSocket close code for "policy violation": a rejected token, or an incompatible version. */
const CLOSE_REJECTED = 1008;

/**
 * One authenticated Offline Mode socket. Every frame is sealed with the direction's key, and
 * both directions are chained so frames are encrypted, sent, decrypted and delivered in the
 * order they were written — encryption is asynchronous, and a file chunk overtaking its
 * file-chunk-start would be dropped.
 */
class SecureChannel {
    private outbound: Promise<void> = Promise.resolve();
    private inbound: Promise<void> = Promise.resolve();

    constructor(private sendKey: CryptoKey, private receiveKey: CryptoKey) { }

    /** Encrypt `message` and pass the sealed frame to `write`, in call order. */
    send(message: any, write: (frame: Uint8Array) => void): Promise<void> {
        let plaintext: Uint8Array;
        try {
            const { header, body } = splitBinaryPayload(message);
            // Framed now, synchronously: callers may drop their buffers once send() returns.
            plaintext = packFrame(header, body);
        } catch (e) {
            return Promise.reject(e);
        }
        const done = this.outbound.then(async () => write(await sealFrame(this.sendKey, plaintext)));
        this.outbound = done.catch(() => { /* reported to this send's caller */ });
        return done;
    }

    /** Decrypt `frame` after every earlier one, then hand the message to `deliver`. */
    receive(frame: Uint8Array, deliver: (message: any) => void, onError: (e: unknown) => void) {
        this.inbound = this.inbound
            .then(async () => {
                const plaintext = await openFrame(this.receiveKey, frame);
                const { header, body } = unpackFrame(plaintext);
                deliver(joinBinaryPayload(header, body));
            })
            .catch(onError);
    }
}

/** Bytes of a ws 'message' payload (Buffer, ArrayBuffer or fragments). */
function frameBytes(data: any): Uint8Array {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (Array.isArray(data)) {
        const parts = data.map(frameBytes);
        const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
        let offset = 0;
        for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
        return out;
    }
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new Error('Unsupported frame type');
}

// ─── DirectIpServer ────────────────────────────────────────────────────────────

interface ServerClientEntry {
    socket: any;
    lastHeard: number;
    channel: SecureChannel;
}

export class DirectIpServer {
    private wss: any | null = null;
    /** deviceId → authenticated socket */
    private clients: Map<string, ServerClientEntry> = new Map();
    private pin: string;
    private reapInterval: number | null = null;
    private notifiedOutdatedClient = false;
    /**
     * Resolves once the socket is actually bound, rejects if it never binds. Callers must
     * await this before telling the user that hosting is active — `new WebSocketServer()`
     * does not throw on EADDRINUSE, the failure arrives asynchronously.
     */
    public readonly listening: Promise<void>;

    constructor(private plugin: ObsidianDecentralizedPlugin, port: number, pin: string) {
        this.pin = pin;
        if (Platform.isMobile) {
            this.plugin.showNotice("Offline Host mode is only available on Desktop.", 'important');
            this.listening = Promise.reject(new Error("Offline Host mode is only available on Desktop."));
        } else {
            this.listening = this.start(port);
        }
        // The caller owns the real error reporting; this only stops Node/Electron from
        // flagging an unhandled rejection when nobody happens to be awaiting yet.
        this.listening.catch(() => { /* reported by the caller */ });
    }

    private async start(port: number): Promise<void> {
        let WebSocketServer: any;
        try {
            // Goes through ws-loader.js rather than `await import('ws')`: a dynamic import gets
            // its namespace evaluated at bundle load under inlineDynamicImports, which dragged
            // ws's `crypto`/`stream` requires onto mobile and stopped the plugin loading there.
            // loadWs() defers the real work to this call, which only desktop ever reaches.
            ({ WebSocketServer } = loadWs());
        } catch (err: any) {
            this.plugin.log("Failed to load the 'ws' module:", err);
            throw new Error(`Could not load the WebSocket server module: ${err?.message || err}`);
        }

        await new Promise<void>((resolve, reject) => {
            let settled = false;
            try {
                this.wss = new WebSocketServer({ port });
            } catch (err: any) {
                reject(new Error(`Could not start the offline host on port ${port}: ${err?.message || err}`));
                return;
            }
            this.wss.once('listening', () => {
                settled = true;
                resolve();
            });
            this.wss.once('error', (err: any) => {
                if (settled) return;
                settled = true;
                const reason = err?.code === 'EADDRINUSE'
                    ? `port ${port} is already in use — another vault or app may be hosting already`
                    : (err?.message || String(err));
                try { this.wss?.close(); } catch (_) { /* ignore */ }
                this.wss = null;
                reject(new Error(`Could not start the offline host: ${reason}`));
            });
        });

        this.wss.on('connection', (socket: any, request: any) => this.acceptSocket(socket, request));

        this.wss.on('error', (err: Error) => {
            this.plugin.showNotice(`Offline server error: ${err.message}`, 'error');
            this.plugin.log("Offline Server Error:", err);
            this.stop();
        });

        // Stale-client reaper: terminate clients that haven't sent anything
        // within the liveness window (mirrors client-side heartbeat timeout).
        this.reapInterval = setInterval(() => {
            const now = Date.now();
            const toReap: string[] = [];
            for (const [deviceId, entry] of this.clients.entries()) {
                if (now - entry.lastHeard > LIVENESS_TIMEOUT_MS) {
                    toReap.push(deviceId);
                }
            }
            for (const deviceId of toReap) {
                const entry = this.clients.get(deviceId);
                if (entry) {
                    this.plugin.log(`Server: reaping stale client ${deviceId} (silent for ${Math.round((now - entry.lastHeard) / 1000)}s)`);
                    try { entry.socket.close(); } catch (_) { /* ignore */ }
                    this.clients.delete(deviceId);
                    this.plugin.connections?.delete(deviceId);
                    this.plugin.updateStatus();
                }
            }
        }, LIVENESS_TIMEOUT_MS) as any as number;

        this.plugin.log(`Offline WebSocket server listening on port ${port}`);
    }

    /** A new socket: challenge it, and admit it only once it proves it holds the token. */
    private acceptSocket(socket: any, request: any) {
        let url: URL;
        try {
            url = new URL(request?.url || '/', 'http://localhost');
        } catch {
            socket.close(CLOSE_REJECTED, 'Bad request');
            return;
        }
        if (url.searchParams.has('pin')) {
            // Older versions sent the token in the URL, in plaintext, and then spoke plaintext.
            if (!this.notifiedOutdatedClient) {
                this.notifiedOutdatedClient = true;
                this.plugin.showNotice('A device running an older version of Obsidian Decentralized tried to join. Update it to the same version as this computer.', 'warning', 12000);
            }
            socket.close(CLOSE_REJECTED, 'Update Obsidian Decentralized on this device');
            return;
        }
        const deviceId = (url.searchParams.get('deviceId') || '').slice(0, 128);
        if (!deviceId) {
            socket.close(CLOSE_REJECTED, 'Missing device ID');
            return;
        }

        const serverNonce = randomNonce();
        const conn = this.connectionFor(deviceId, socket);
        let channel: SecureChannel | null = null;
        let authenticating = false;
        const authTimer = setTimeout(() => {
            if (!channel) {
                try { socket.close(4001, 'Authentication timed out'); } catch (_) { /* gone */ }
            }
        }, AUTH_TIMEOUT_MS);

        socket.on('message', (data: any, isBinary: boolean) => {
            if (!channel) {
                if (isBinary || authenticating) {
                    socket.close(CLOSE_REJECTED, 'Not authenticated');
                    return;
                }
                authenticating = true;
                const admit = (ready: SecureChannel) => {
                    clearTimeout(authTimer);
                    channel = ready;
                    const previous = this.clients.get(deviceId);
                    this.clients.set(deviceId, { socket, lastHeard: Date.now(), channel: ready });
                    // The same device reconnected before its old socket died: retire the old one.
                    if (previous && previous.socket !== socket) {
                        try { previous.socket.close(1000, 'Replaced by a newer connection'); } catch (_) { /* gone */ }
                    }
                    this.plugin.updateStatus();
                };
                this.completeAuth(socket, deviceId, serverNonce, data, admit).catch(e => {
                    this.plugin.log(`Server: authentication of ${deviceId} failed:`, e);
                    try { socket.close(1011, 'Authentication failed'); } catch (_) { /* gone */ }
                });
                return;
            }

            if (!isBinary) {
                this.plugin.log(`Server: ignoring an unencrypted frame from ${deviceId}.`);
                return;
            }
            const entry = this.clients.get(deviceId);
            if (entry && entry.socket === socket) entry.lastHeard = Date.now();
            let bytes: Uint8Array;
            try {
                bytes = frameBytes(data);
            } catch (e) {
                this.plugin.log(`Server: unreadable frame from ${deviceId}:`, e);
                return;
            }
            channel.receive(
                bytes,
                message => this.deliver(deviceId, conn, message),
                e => this.plugin.log(`Server: dropped a frame from ${deviceId} that did not decrypt:`, e),
            );
        });

        socket.on('close', () => {
            clearTimeout(authTimer);
            // Only remove the registration if it still belongs to THIS socket. A stale socket's
            // late close event must not evict a client that has already reconnected.
            if (this.clients.get(deviceId)?.socket === socket) {
                this.clients.delete(deviceId);
                this.plugin.connections?.delete(deviceId);
            }
            this.plugin.updateStatus();
        });

        socket.on('error', (err: any) => {
            this.plugin.log(`WS Client Error (${deviceId}):`, err);
        });

        socket.send(JSON.stringify({ type: AUTH_CHALLENGE, v: DIRECT_IP_AUTH_VERSION, nonce: bytesToBase64(serverNonce) }));
    }

    /** Check the joining device's proof; on success answer with ours and return the channel. */
    private async completeAuth(socket: any, deviceId: string, serverNonce: Uint8Array, data: any, admit: (channel: SecureChannel) => void): Promise<void> {
        let message: any;
        try {
            message = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(frameBytes(data)));
        } catch {
            socket.close(CLOSE_REJECTED, 'Bad handshake');
            return;
        }
        const clientNonce = base64ToBytes(message?.nonce, 16);
        if (message?.type !== AUTH_PROOF || !clientNonce) {
            socket.close(CLOSE_REJECTED, 'Bad handshake');
            return;
        }
        const expected = await clientProof(this.pin, serverNonce, clientNonce, deviceId);
        if (!proofsMatch(message.proof, expected)) {
            this.plugin.log(`Server: rejecting ${deviceId}: wrong token.`);
            socket.close(CLOSE_REJECTED, 'Invalid token');
            return;
        }
        const keys = await deriveSessionKeys(this.pin, serverNonce, clientNonce, deviceId);
        const proof = await hostProof(this.pin, serverNonce, clientNonce, deviceId);
        if (socket.readyState !== 1 /* OPEN */) return;
        // Admitted before auth-ok goes out, so the device's first encrypted frame finds it ready.
        admit(new SecureChannel(keys.hostToClient, keys.clientToHost));
        socket.send(JSON.stringify({ type: AUTH_OK, proof }));
    }

    /** The connection object main.ts sees for one authenticated socket. */
    private connectionFor(deviceId: string, socket: any): any {
        return {
            send: (msg: any) => this.sendTo(deviceId, msg),
            peer: deviceId,
            get open() { return socket.readyState === 1; },
            // main.ts (heartbeat, rejections) calls conn.close(); without this method those
            // call sites threw TypeError every tick.
            close: () => {
                try { socket.close(); } catch (_) { /* ignore */ }
                if (this.clients.get(deviceId)?.socket === socket) {
                    this.clients.delete(deviceId);
                }
                this.plugin.connections?.delete(deviceId);
                this.plugin.updateStatus();
            },
        };
    }

    private deliver(deviceId: string, mockConn: any, message: any) {
        this.plugin.handleRawIncomingData(message, mockConn).catch((e: any) => {
            this.plugin.log(`Server: Failed to handle raw incoming data from ${deviceId}:`, e);
            this.plugin.showNotice(`Error processing received sync message from ${deviceId}.`, 'error');
        });
    }

    getClients(): string[] {
        return Array.from(this.clients.keys());
    }

    /** Access token shown on the hosting screen. Needed after the modal is closed and reopened. */
    getPin(): string {
        return this.pin;
    }

    sendTo(peerId: string, data: any) {
        const entry = this.clients.get(peerId);
        if (!entry || entry.socket.readyState !== 1 /* OPEN */) return;
        entry.channel
            .send(data, frame => {
                if (entry.socket.readyState === 1) entry.socket.send(frame);
            })
            .catch(err => this.plugin.log(`DirectIpServer: Failed to send message to peer ${peerId}:`, err));
    }

    hasClient(peerId: string): boolean {
        return this.clients.has(peerId);
    }

    getBufferedAmount(peerId: string): number {
        const entry = this.clients.get(peerId);
        if (!entry) return 0;
        return entry.socket._socket ? entry.socket._socket.bufferSize : entry.socket.bufferedAmount;
    }

    /** Send to every connected device (each with its own keys). */
    send(data: any, excludePeerId?: string) {
        for (const deviceId of this.clients.keys()) {
            if (deviceId !== excludePeerId) this.sendTo(deviceId, data);
        }
    }

    stop() {
        if (this.reapInterval !== null) {
            clearInterval(this.reapInterval);
            this.reapInterval = null;
        }
        for (const entry of this.clients.values()) {
            try { entry.socket.close(); } catch (_) { /* ignore */ }
        }
        this.clients.clear();
        if (this.wss) {
            this.wss.close();
        }
        this.wss = null;
        // Drop the plugin's reference too, otherwise calculateStatus keeps reporting a live
        // host after the socket is gone (a dead server still read as "hosting" in the UI).
        if (this.plugin.directIpServer === this) {
            this.plugin.directIpServer = null;
        }
        this.plugin.log("Offline Server stopped.");
    }
}

// ─── DirectIpClient ────────────────────────────────────────────────────────────

type PendingSend = { data: any; resolve?: () => void; reject?: (e: any) => void };

export class DirectIpClient {
    /** True once authenticated AND at least one message has been received. */
    public isLive: boolean = false;
    /** True once the host has proved it holds the token and frames can flow. */
    public isOpen: boolean = false;
    /** Set when a fatal, non-retriable error has occurred (e.g. a rejected token). */
    public isFatalError: boolean = false;
    /** What went wrong, for the Connect screen, when isFatalError is set. */
    public fatalReason: string | null = null;

    private ws: WebSocket | null = null;
    private channel: SecureChannel | null = null;
    private pendingAuth: { serverNonce: Uint8Array; clientNonce: Uint8Array } | null = null;
    private sendBuffer: PendingSend[] = [];
    private isStopped = false;

    // Reconnect backoff state
    private reconnectAttempts = 0;
    private reconnectTimeout: number | null = null;
    private authTimeout: number | null = null;

    // Heartbeat / keep-alive state
    private heartbeatInterval: number | null = null;
    private lastHeardAt: number = 0;

    /** The connection object main.ts sees for the host. */
    private readonly hostConnection = (() => {
        const client = this;
        return {
            send: (data: any) => client.send(data),
            peer: 'direct-ip-host',
            get open() { return client.isOpen; },
            // main.ts heartbeat calls conn.close() on silent peers; map it to a
            // reconnect cycle instead of throwing TypeError.
            close: () => client.triggerReconnect(),
        } as any;
    })();

    /**
     * @param greeting builds the first message of every authenticated link (the handshake),
     *   sent before anything queued while the link was down.
     */
    constructor(private plugin: ObsidianDecentralizedPlugin, private config: DirectIpConfig, private greeting?: () => any) {
        this.connect();
    }

    getBufferedAmount(): number {
        return this.ws ? this.ws.bufferedAmount : 0;
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    private stopHeartbeat() {
        if (this.heartbeatInterval !== null) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    private clearAuthTimeout() {
        if (this.authTimeout !== null) {
            clearTimeout(this.authTimeout);
            this.authTimeout = null;
        }
    }

    /** Reject and drop every queued send. Without this, callers awaiting send()
     *  hang forever when the connection never (re)opens. */
    private drainSendBuffer(reason: string) {
        const pending = this.sendBuffer;
        this.sendBuffer = [];
        for (const item of pending) {
            if (item.data?.transferId) {
                this.plugin.rejectPendingAck(item.data.transferId, reason);
            }
            item.reject?.(new Error(reason));
        }
    }

    private startHeartbeat() {
        this.stopHeartbeat();
        this.lastHeardAt = Date.now(); // socket just opened — reset the clock
        this.heartbeatInterval = window.setInterval(() => {
            if (!this.ws || this.ws.readyState !== 1 /* WebSocket.OPEN */ || !this.channel) {
                this.stopHeartbeat();
                return;
            }

            void this.send({ type: 'ping' });

            // Check liveness window — if exceeded, force-close to trigger reconnect
            if (Date.now() - this.lastHeardAt > LIVENESS_TIMEOUT_MS) {
                this.plugin.log(`DirectIpClient: host silent for >${LIVENESS_TIMEOUT_MS / 1000}s — force-closing socket`);
                this.stopHeartbeat();
                this.ws?.close();
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    /**
     * Compute the next backoff delay, update status to "reconnecting", and
     * schedule a call to connect().
     */
    private scheduleReconnect() {
        if (this.isStopped || this.isFatalError) return;

        this.reconnectAttempts++;
        const backoff = Math.min(30000, this.reconnectAttempts * 2000);

        this.plugin.log(`DirectIpClient: reconnect attempt ${this.reconnectAttempts} in ${backoff / 1000}s`);
        this.plugin.updateStatus({
            text: `Reconnecting to host… (${this.reconnectAttempts})`,
            icon: 'refresh-cw',
            spin: true,
            state: 'loading',
        });

        if (this.reconnectTimeout !== null) {
            clearTimeout(this.reconnectTimeout);
        }
        this.reconnectTimeout = window.setTimeout(() => {
            this.reconnectTimeout = null;
            this.connect();
        }, backoff);
    }

    /** Stop for good and say why: retrying cannot fix a wrong token or address. */
    private fail(reason: string) {
        this.isFatalError = true;
        this.fatalReason = reason;
        this.isOpen = false;
        this.isLive = false;
        this.channel = null;
        this.stopHeartbeat();
        this.clearAuthTimeout();
        this.drainSendBuffer(reason);
        this.plugin.log(`DirectIpClient: ${reason}`);
        this.plugin.showNotice(reason, 'error');
        this.plugin.updateStatus({ text: 'Could not join the offline host', icon: 'shield-off', state: 'error' });
    }

    private connect() {
        if (this.isStopped) return;
        this.isFatalError = false;
        this.fatalReason = null;
        this.channel = null;
        this.pendingAuth = null;

        // The token is deliberately NOT in the URL: it is proven, never sent.
        const wsUrl = `ws://${formatHostForUrl(this.config.host)}:${this.config.port}/?deviceId=${encodeURIComponent(this.plugin.settings.deviceId)}&v=${DIRECT_IP_AUTH_VERSION}`;
        let ws: WebSocket;
        try {
            ws = new WebSocket(wsUrl);
        } catch (e) {
            // A malformed address throws synchronously, and used to escape as an uncaught error
            // that left the Connect screen spinning.
            this.fail(`"${this.config.host}" is not a valid address. Enter the IP shown on the hosting computer, like 192.168.1.20.`);
            return;
        }
        this.ws = ws;
        ws.binaryType = 'arraybuffer';
        // Events from a socket we have since replaced must not touch the current one's state.
        const isCurrent = () => this.ws === ws;

        ws.onopen = () => {
            if (!isCurrent()) return;
            if (this.reconnectTimeout !== null) {
                clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = null;
            }
            // Wait for the host's challenge; something that never sends one is not our host.
            this.clearAuthTimeout();
            this.authTimeout = window.setTimeout(() => {
                this.authTimeout = null;
                if (isCurrent() && !this.channel) ws.close();
            }, AUTH_TIMEOUT_MS);
            this.plugin.updateStatus({ text: 'Verifying the host…', icon: 'plug', spin: true, state: 'loading' });
        };

        // Authentication steps are asynchronous, and the host may send its first encrypted
        // frame right behind auth-ok. Until the channel exists, every frame waits its turn.
        let authStep: Promise<void> = Promise.resolve();

        const receiveEncrypted = (data: unknown) => {
            if (typeof data === 'string') {
                this.plugin.log('DirectIpClient: ignoring an unencrypted frame.');
                return;
            }
            let bytes: Uint8Array;
            try {
                bytes = frameBytes(data);
            } catch (e) {
                this.plugin.log('DirectIpClient: unreadable frame dropped:', e);
                return;
            }
            this.channel?.receive(
                bytes,
                message => this.deliver(message),
                e => this.plugin.log('DirectIpClient: dropped a frame that did not decrypt:', e),
            );
        };

        ws.onmessage = (event) => {
            if (!isCurrent()) return;
            this.lastHeardAt = Date.now();
            if (this.channel) {
                receiveEncrypted(event.data);
                return;
            }
            authStep = authStep
                .then(async () => {
                    if (!isCurrent()) return;
                    if (this.channel) receiveEncrypted(event.data);
                    else await this.handleAuthMessage(ws, event.data);
                })
                .catch(e => {
                    this.plugin.log('DirectIpClient: authentication failed:', e);
                    ws.close();
                });
        };

        ws.onclose = (event) => {
            if (!isCurrent()) return;
            this.isOpen = false;
            this.isLive = false;
            this.channel = null;
            this.pendingAuth = null;
            this.stopHeartbeat();
            this.clearAuthTimeout();

            // Intentional shutdown, or already failed for good — do nothing
            if (this.isStopped || this.isFatalError) return;

            if (event.code === CLOSE_REJECTED) {
                this.fail('The host rejected this device. Check the token on the hosting computer (Connect devices → Offline Mode), and make sure both devices run the same version of Obsidian Decentralized.');
                return;
            }

            // All other closes — schedule exponential backoff reconnect
            this.scheduleReconnect();
        };

        ws.onerror = (err) => {
            // onclose always fires after onerror, so reconnect logic lives there.
            this.plugin.log('Offline WS Error:', err);
        };
    }

    private async handleAuthMessage(ws: WebSocket, data: unknown) {
        if (typeof data !== 'string') {
            ws.close();
            return;
        }
        let message: any;
        try {
            message = JSON.parse(data);
        } catch {
            ws.close();
            return;
        }
        const deviceId = this.plugin.settings.deviceId;

        if (message?.type === AUTH_CHALLENGE && !this.pendingAuth) {
            const serverNonce = base64ToBytes(message.nonce, 16);
            if (!serverNonce) {
                ws.close();
                return;
            }
            const clientNonce = randomNonce();
            this.pendingAuth = { serverNonce, clientNonce };
            const proof = await clientProof(this.config.pin, serverNonce, clientNonce, deviceId);
            if (this.ws !== ws || ws.readyState !== 1) return;
            ws.send(JSON.stringify({ type: AUTH_PROOF, nonce: bytesToBase64(clientNonce), proof }));
            return;
        }

        if (message?.type === AUTH_OK && this.pendingAuth) {
            const { serverNonce, clientNonce } = this.pendingAuth;
            this.pendingAuth = null;
            const expected = await hostProof(this.config.pin, serverNonce, clientNonce, deviceId);
            if (this.ws !== ws) return;
            if (!proofsMatch(message.proof, expected)) {
                // Whatever answered at this address does not know the token.
                this.fail(`The device at ${this.config.host} could not prove it is the host that issued this token. Check the IP address.`);
                ws.close();
                return;
            }
            const keys = await deriveSessionKeys(this.config.pin, serverNonce, clientNonce, deviceId);
            if (this.ws !== ws || ws.readyState !== 1) return;
            this.channel = new SecureChannel(keys.clientToHost, keys.hostToClient);
            this.clearAuthTimeout();
            this.reconnectAttempts = 0;
            this.isOpen = true;
            this.plugin.showNotice(`Connected to Offline Host at ${this.config.host}`, 'important', 3000);
            this.plugin.updateStatus({ text: 'Connected — verifying link…', icon: 'plug', spin: true, state: 'loading' });
            this.startHeartbeat();
            if (this.greeting) this.sendBuffer.unshift({ data: this.greeting() });
            this.flushSendBuffer();
            return;
        }

        this.plugin.log(`DirectIpClient: unexpected ${message?.type} during authentication.`);
        ws.close();
    }

    private deliver(message: any) {
        if (!this.isLive) {
            this.isLive = true;
            // First confirmed live message — emit proper connected status
            this.plugin.updateStatus();
        }
        this.plugin.handleRawIncomingData(message, this.hostConnection).catch((e: any) => {
            this.plugin.log('Client: Failed to handle raw incoming data:', e);
            this.plugin.showNotice('Error processing received sync message.', 'error');
        });
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Queue `data` for the host; it goes out, encrypted, once the link is authenticated.
     * The returned promise is marked handled up front: most callers fire and forget, and a
     * link that drops used to reject every one of them as an unhandled rejection.
     */
    send(data: any): Promise<void> {
        const sent = new Promise<void>((resolve, reject) => {
            if (this.sendBuffer.length >= 100) {
                const dropped = this.sendBuffer.shift(); // Drop oldest message
                if (dropped?.data?.transferId) {
                    this.plugin.rejectPendingAck(dropped.data.transferId, 'Buffer overflow');
                }
                dropped?.reject?.(new Error('Buffer overflow'));
            }
            this.sendBuffer.push({ data, resolve, reject });
            this.flushSendBuffer();
        });
        sent.catch(() => { /* observed by callers that await it */ });
        return sent;
    }

    private flushSendBuffer() {
        const ws = this.ws;
        const channel = this.channel;
        if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */ || !channel) return;

        while (this.sendBuffer.length > 0) {
            const item = this.sendBuffer.shift()!;
            channel
                .send(item.data, frame => {
                    if (ws.readyState !== 1) throw new Error('Connection closed');
                    ws.send(frame);
                })
                .then(() => item.resolve?.(), (e: any) => {
                    this.plugin.log('DirectIpClient: send failed:', e);
                    if (item.data?.transferId) {
                        this.plugin.rejectPendingAck(item.data.transferId, `Send failed: ${e?.message || e}`);
                    }
                    item.reject?.(e);
                });
        }
    }

    /**
     * Drop the current socket and reconnect. The plugin heartbeat calls this every 5 s while
     * the host is silent, so it must not disturb a reconnect already on its way: resetting
     * the backoff timer on each call meant that once the delay passed 5 s the timer never
     * fired, and a device that lost its host for 20 s never reconnected. A network change
     * passes resetBackoff to retry promptly.
     */
    public triggerReconnect(opts?: { resetBackoff?: boolean }) {
        if (this.isStopped || this.isFatalError) return;
        if (opts?.resetBackoff) this.reconnectAttempts = 0;
        const state = this.ws?.readyState;
        if (state === 0 /* CONNECTING */ || state === 2 /* CLOSING */) return; // its outcome decides
        if (state === 1 /* OPEN */) {
            this.stopHeartbeat();
            this.ws!.close(); // onclose schedules the reconnect
            return;
        }
        if (this.reconnectTimeout !== null) {
            if (!opts?.resetBackoff) return; // already scheduled
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        this.scheduleReconnect();
    }

    stop() {
        this.isStopped = true;
        this.isOpen = false;
        this.isLive = false;
        this.channel = null;
        this.stopHeartbeat();
        this.clearAuthTimeout();
        this.drainSendBuffer('Client stopped');

        if (this.reconnectTimeout !== null) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.plugin.showNotice("Disconnected from Offline Host.", 'transient', 3000);
    }
}
