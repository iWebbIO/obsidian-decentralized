import { Platform } from 'obsidian';
import { DirectIpConfig } from './types';
import type ObsidianDecentralizedPlugin from './main';

// Heartbeat constants (mirror main.ts startHeartbeat)
const HEARTBEAT_INTERVAL_MS = 5000;   // ping every 5 s
const LIVENESS_TIMEOUT_MS   = 20000;  // declare dead after 20 s of silence

// Custom Framing Helpers
function encodeMessage(msg: any): string | ArrayBuffer {
    if (msg.type === 'file-chunk-data' && (msg.data instanceof ArrayBuffer || msg.data instanceof Uint8Array)) {
        const { data, ...header } = msg;
        const headerStr = JSON.stringify(header);
        const encoder = new TextEncoder();
        const headerBytes = encoder.encode(headerStr);
        const binaryData = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);
        const buffer = new Uint8Array(4 + headerBytes.length + binaryData.byteLength);
        new DataView(buffer.buffer).setUint32(0, headerBytes.length, true);
        buffer.set(headerBytes, 4);
        buffer.set(binaryData, 4 + headerBytes.length);
        return buffer.buffer;
    } else if (msg.type === 'file-batch-binary' && (msg.data instanceof ArrayBuffer || msg.data instanceof Uint8Array)) {
        const { data, ...header } = msg;
        const headerStr = JSON.stringify(header);
        const encoder = new TextEncoder();
        const headerBytes = encoder.encode(headerStr);
        const binaryData = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);
        const buffer = new Uint8Array(4 + headerBytes.length + binaryData.byteLength);
        new DataView(buffer.buffer).setUint32(0, headerBytes.length, true);
        buffer.set(headerBytes, 4);
        buffer.set(binaryData, 4 + headerBytes.length);
        return buffer.buffer;
    } else if (msg.type === 'file-update' && msg.encoding === 'binary' && (msg.content instanceof ArrayBuffer || msg.content instanceof Uint8Array)) {
        const { content, ...header } = msg;
        const headerStr = JSON.stringify(header);
        const encoder = new TextEncoder();
        const headerBytes = encoder.encode(headerStr);
        const binaryData = msg.content instanceof Uint8Array ? msg.content : new Uint8Array(msg.content);
        const buffer = new Uint8Array(4 + headerBytes.length + binaryData.byteLength);
        new DataView(buffer.buffer).setUint32(0, headerBytes.length, true);
        buffer.set(headerBytes, 4);
        buffer.set(binaryData, 4 + headerBytes.length);
        return buffer.buffer;
    }
    return JSON.stringify(msg);
}

function decodeMessage(data: string | ArrayBuffer | Uint8Array | Blob): any {
    if (typeof data === 'string') {
        return JSON.parse(data);
    }
    let buffer: ArrayBuffer;
    if (data instanceof ArrayBuffer) {
        buffer = data;
    } else if (data instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(data))) {
        buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    } else {
        throw new Error('Unsupported data type');
    }

    const view = new DataView(buffer);
    const headerLen = view.getUint32(0, true);
    const headerBytes = new Uint8Array(buffer, 4, headerLen);
    const decoder = new TextDecoder();
    const headerStr = decoder.decode(headerBytes);
    const header = JSON.parse(headerStr);
    const dataBuffer = buffer.slice(4 + headerLen);

    if (header.type === 'file-chunk-data' || header.type === 'file-batch-binary') {
        header.data = dataBuffer;
    } else if (header.type === 'file-update') {
        header.content = dataBuffer;
    }
    return header;
}

// ─── DirectIpServer ────────────────────────────────────────────────────────────

interface ServerClientEntry {
    socket: any;
    lastHeard: number;
}

export class DirectIpServer {
    private wss: any | null = null;
    /** deviceId → {socket, lastHeard} */
    private clients: Map<string, ServerClientEntry> = new Map();
    private pin: string;
    private reapInterval: number | null = null;

    constructor(private plugin: ObsidianDecentralizedPlugin, port: number, pin: string) {
        if (Platform.isMobile) {
            this.plugin.showNotice("Offline Host mode is only available on Desktop.", 'important');
            return;
        }
        this.pin = pin;
        this.start(port);
    }

    private start(port: number) {
        const { WebSocketServer } = require('ws');
        this.wss = new WebSocketServer({ port });
        
        this.wss.on('connection', (socket: any, request: any) => {
            const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
            const pin = url.searchParams.get('pin');
            const deviceId = url.searchParams.get('deviceId') || 'unknown';

            if (pin !== this.pin) {
                socket.close(1008, 'Invalid PIN');
                return;
            }

            const entry: ServerClientEntry = { socket, lastHeard: Date.now() };
            this.clients.set(deviceId, entry);

            socket.on('message', (data: any, isBinary: boolean) => {
                // Update liveness timestamp on every message from this client
                const e = this.clients.get(deviceId);
                if (e) e.lastHeard = Date.now();

                try {
                    let parsedData: any;
                    if (isBinary || data instanceof Uint8Array || data instanceof ArrayBuffer) {
                        parsedData = decodeMessage(data);
                    } else {
                        parsedData = JSON.parse(data.toString());
                    }

                    const mockConn = {
                        send: (msg: any) => this.sendTo(deviceId, msg),
                        peer: deviceId,
                        open: true,
                    } as any;

                    this.plugin.handleRawIncomingData(parsedData, mockConn).catch((e: any) => console.error(e));
                } catch (e) {
                    this.plugin.log('Error parsing WS message', e);
                }
            });

            socket.on('close', () => {
                this.clients.delete(deviceId);
                this.plugin.updateStatus();
            });
            
            socket.on('error', (err: any) => {
                this.plugin.log(`WS Client Error (${deviceId}):`, err);
            });
        });

        this.wss.on('error', (err: Error) => {
            this.plugin.showNotice(`Offline server error: ${err.message}`, 'error');
            this.plugin.log("Offline Server Error:", err);
            this.wss = null;
        });

        // Stale-client reaper: terminate clients that haven't sent anything
        // within the liveness window (mirrors client-side heartbeat timeout).
        this.reapInterval = window.setInterval(() => {
            const now = Date.now();
            for (const [deviceId, entry] of this.clients.entries()) {
                if (now - entry.lastHeard > LIVENESS_TIMEOUT_MS) {
                    this.plugin.log(`Server: reaping stale client ${deviceId} (silent for ${Math.round((now - entry.lastHeard) / 1000)}s)`);
                    try { entry.socket.close(); } catch (_) { /* ignore */ }
                    this.clients.delete(deviceId);
                    this.plugin.updateStatus();
                }
            }
        }, LIVENESS_TIMEOUT_MS);

        this.plugin.log(`Offline WebSocket server listening on port ${port}`);
    }

    getClients(): string[] {
        return Array.from(this.clients.keys());
    }

    sendTo(peerId: string, data: any) {
        const entry = this.clients.get(peerId);
        if (entry && entry.socket.readyState === 1 /* OPEN */) {
            const encoded = encodeMessage(data);
            entry.socket.send(encoded);
        }
    }

    hasClient(peerId: string): boolean {
        return this.clients.has(peerId);
    }

    getBufferedAmount(peerId: string): number {
        const entry = this.clients.get(peerId);
        return entry ? entry.socket.bufferedAmount : 0;
    }

    send(data: any) {
        const encoded = encodeMessage(data);
        for (const entry of this.clients.values()) {
            if (entry.socket.readyState === 1 /* OPEN */) {
                entry.socket.send(encoded);
            }
        }
    }

    stop() {
        if (this.reapInterval !== null) {
            clearInterval(this.reapInterval);
            this.reapInterval = null;
        }
        if (this.wss) {
            this.wss.close();
            for (const entry of this.clients.values()) {
                try { entry.socket.close(); } catch (_) { /* ignore */ }
            }
            this.clients.clear();
        }
        this.wss = null;
        this.plugin.log("Offline Server stopped.");
    }
}

// ─── DirectIpClient ────────────────────────────────────────────────────────────

export class DirectIpClient {
    /** True once the socket is open AND at least one message has been received. */
    public isLive: boolean = false;
    /** True when the socket is OPEN (TCP layer), independent of liveness. */
    public isOpen: boolean = false;
    /** Set when a fatal, non-retriable error has occurred (e.g. PIN rejection). */
    public isFatalError: boolean = false;

    private ws: WebSocket | null = null;
    private sendBuffer: any[] = [];
    private isStopped = false;

    // Reconnect backoff state
    private reconnectAttempts = 0;
    private reconnectTimeout: number | null = null;

    // Heartbeat / keep-alive state
    private heartbeatInterval: number | null = null;
    private lastHeardAt: number = 0;

    constructor(private plugin: ObsidianDecentralizedPlugin, private config: DirectIpConfig) {
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

    private startHeartbeat() {
        this.stopHeartbeat();
        this.lastHeardAt = Date.now(); // socket just opened — reset the clock
        this.heartbeatInterval = window.setInterval(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                this.stopHeartbeat();
                return;
            }

            // Send a ping to the server
            try {
                this.ws.send(encodeMessage({ type: 'ping' }));
            } catch (e) {
                this.plugin.log('DirectIpClient: failed to send heartbeat ping', e);
            }

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
        if (this.isStopped) return;

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

    private connect() {
        if (this.isStopped) return;
        
        const wsUrl = `ws://${this.config.host}:${this.config.port}/?pin=${encodeURIComponent(this.config.pin)}&deviceId=${encodeURIComponent(this.plugin.settings.deviceId)}`;
        this.ws = new WebSocket(wsUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            // Cancel any pending reconnect timer
            if (this.reconnectTimeout !== null) {
                clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = null;
            }
            // Reset backoff counter
            this.reconnectAttempts = 0;

            this.isOpen = true;
            // isLive remains false until the first incoming message proves the
            // far-end is processing traffic (Phase 4 accuracy requirement).

            this.plugin.showNotice(`Connected to Offline Host at ${this.config.host}`, 'important', 3000);

            // Emit "connecting" until first message confirms liveness
            this.plugin.updateStatus({
                text: 'Connected — verifying link…',
                icon: 'plug',
                spin: true,
                state: 'loading',
            });

            this.startHeartbeat();
            this.flushSendBuffer();
        };

        this.ws.onmessage = (event) => {
            // Every incoming message proves the far-end is alive
            this.lastHeardAt = Date.now();
            if (!this.isLive) {
                this.isLive = true;
                // First confirmed live message — emit proper connected status
                this.plugin.updateStatus();
            }

            try {
                let parsedData: any;
                if (typeof event.data === 'string') {
                    parsedData = JSON.parse(event.data);
                } else if (event.data instanceof ArrayBuffer) {
                    parsedData = decodeMessage(event.data);
                }
                
                const mockConn = {
                    send: (data: any) => this.send(data),
                    peer: 'direct-ip-host',
                    open: true
                } as any;

                this.plugin.handleRawIncomingData(parsedData, mockConn).catch((e: any) => console.error(e));
            } catch (e) {
                this.plugin.log('Offline WS Parse Error:', e);
            }
        };

        this.ws.onclose = (event) => {
            this.isOpen = false;
            this.isLive = false;
            this.stopHeartbeat();

            // Intentional shutdown — do nothing
            if (this.isStopped) return;

            // Fatal: PIN / auth rejection → no retry, surface error
            if (event.code === 1008) {
                this.isFatalError = true;
                this.plugin.log(`DirectIpClient: fatal close (1008 PIN/auth rejection)`);
                this.plugin.showNotice('Connection rejected by host: invalid PIN.', 'error');
                this.plugin.updateStatus({
                    text: 'Host rejected PIN',
                    icon: 'shield-off',
                    state: 'error',
                });
                return;
            }

            // All other closes — schedule exponential backoff reconnect
            this.scheduleReconnect();
        };
        
        this.ws.onerror = (err) => {
            // onclose always fires after onerror, so reconnect logic lives there.
            this.plugin.log('Offline WS Error:', err);
        };
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    async send(data: any) {
        this.sendBuffer.push(data);
        this.flushSendBuffer();
    }

    private flushSendBuffer() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        
        while (this.sendBuffer.length > 0) {
            const data = this.sendBuffer.shift();
            try {
                const encoded = encodeMessage(data);
                this.ws.send(encoded);
            } catch (e) {
                this.sendBuffer.unshift(data); // Put it back on failure
                break;
            }
        }
    }

    /**
     * Force-close the current socket and immediately begin the backoff-reconnect
     * cycle.  Called by the network-change handler in main.ts (Phase 3.2).
     */
    public triggerReconnect() {
        if (this.isStopped) return;
        this.stopHeartbeat();
        if (this.ws) {
            // Remove handlers before force-closing so onclose doesn't double-schedule
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.close();
            this.ws = null;
        }
        this.isOpen = false;
        this.isLive = false;
        this.scheduleReconnect();
    }

    startPolling() {
        // Legacy compat, no-op for WebSockets
    }

    stop() {
        this.isStopped = true;
        this.isOpen = false;
        this.isLive = false;
        this.stopHeartbeat();

        if (this.reconnectTimeout !== null) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.plugin.showNotice("Disconnected from Offline Host.", 'important', 3000);
    }
}
