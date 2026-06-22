import { Platform } from 'obsidian';
import { DirectIpConfig } from './types';
import type ObsidianDecentralizedPlugin from './main';

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

export class DirectIpServer {
    private wss: any | null = null;
    private clients: Map<string, any> = new Map();
    private pin: string;

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

            this.clients.set(deviceId, socket);

            socket.on('message', (data: any, isBinary: boolean) => {
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

        this.plugin.log(`Offline WebSocket server listening on port ${port}`);
    }

    getClients(): string[] {
        return Array.from(this.clients.keys());
    }

    sendTo(peerId: string, data: any) {
        const client = this.clients.get(peerId);
        if (client && client.readyState === 1 /* OPEN */) {
            const encoded = encodeMessage(data);
            client.send(encoded);
        }
    }

    hasClient(peerId: string): boolean {
        return this.clients.has(peerId);
    }

    getBufferedAmount(peerId: string): number {
        const client = this.clients.get(peerId);
        return client ? client.bufferedAmount : 0;
    }

    send(data: any) {
        const encoded = encodeMessage(data);
        for (const client of this.clients.values()) {
            if (client.readyState === 1 /* OPEN */) {
                client.send(encoded);
            }
        }
    }

    stop() {
        if (this.wss) {
            this.wss.close();
            for (const client of this.clients.values()) {
                client.close();
            }
            this.clients.clear();
        }
        this.wss = null;
        this.plugin.log("Offline Server stopped.");
    }
}

export class DirectIpClient {
    public isOpen: boolean = false;
    private ws: WebSocket | null = null;
    private sendBuffer: any[] = [];
    private isStopped = false;
    
    constructor(private plugin: ObsidianDecentralizedPlugin, private config: DirectIpConfig) {
        this.connect();
    }
    
    getBufferedAmount(): number {
        return this.ws ? this.ws.bufferedAmount : 0;
    }

    private connect() {
        if (this.isStopped) return;
        
        const wsUrl = `ws://${this.config.host}:${this.config.port}/?pin=${encodeURIComponent(this.config.pin)}&deviceId=${encodeURIComponent(this.plugin.settings.deviceId)}`;
        this.ws = new WebSocket(wsUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            this.isOpen = true;
            this.plugin.showNotice(`Connected to Offline Host at ${this.config.host}`, 'important', 3000);
            this.flushSendBuffer();
        };

        this.ws.onmessage = (event) => {
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

        this.ws.onclose = () => {
            this.isOpen = false;
            if (!this.isStopped) {
                this.plugin.updateStatus({ text: 'Host Unreachable', icon: 'server-off', state: 'error' });
            }
        };
        
        this.ws.onerror = (err) => {
            this.plugin.log('Offline WS Error:', err);
        };
    }

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

    startPolling() {
        // Legacy compat, no-op for WebSockets
    }

    stop() {
        this.isStopped = true;
        this.isOpen = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.plugin.showNotice("Disconnected from Offline Host.", 'important', 3000);
    }
}
