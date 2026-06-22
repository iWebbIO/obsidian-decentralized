import { Platform, requestUrl } from 'obsidian';
import { DirectIpConfig, FileUpdatePayload } from './types';
import { arrayBufferToBase64, base64ToArrayBuffer } from './utils';
import type ObsidianDecentralizedPlugin from './main';

export class DirectIpServer {
    private server: any | null = null;
    private clients: Map<string, { lastSeen: number, queue: { data: any, size: number }[], bufferedAmount: number }> = new Map();
    private pin: string;
    private readonly MAX_QUEUE_SIZE = 2000;

    constructor(private plugin: ObsidianDecentralizedPlugin, port: number, pin: string) {
        if (Platform.isMobile) {
            this.plugin.showNotice("Offline Host mode is only available on Desktop.", 'important');
            return;
        }
        this.pin = pin;
        this.start(port);
    }

    private start(port: number) {
        const http = require('http');
        this.server = http.createServer(this.handleRequest.bind(this));
        this.server.on('error', (err: Error) => {
            this.plugin.showNotice(`Offline server error: ${err.message}`, 'error');
            this.plugin.log("Offline Server Error:", err);
            this.server = null;
        });
        this.server.listen(port, () => {
            this.plugin.log(`Offline server listening on port ${port}`);
        });
    }

    getClients(): string[] {
        const now = Date.now();
        for (const [id, client] of this.clients.entries()) {
            if (now - client.lastSeen > 10000) {
                this.clients.delete(id);
            }
        }
        return Array.from(this.clients.keys());
    }

    sendTo(peerId: string, data: any) {
        const client = this.clients.get(peerId);
        if (client) {
            const dataStr = JSON.stringify(data);
            const size = dataStr.length;
            if (client.queue.length >= this.MAX_QUEUE_SIZE) {
                const evicted = client.queue.splice(0, client.queue.length - this.MAX_QUEUE_SIZE + 1);
                const evictedSize = evicted.reduce((sum, item) => sum + item.size, 0);
                client.bufferedAmount = Math.max(0, client.bufferedAmount - evictedSize);
            }
            client.queue.push({ data, size });
            client.bufferedAmount += size;
        }
    }

    hasClient(peerId: string): boolean {
        this.getClients();
        return this.clients.has(peerId);
    }

    getBufferedAmount(peerId: string): number {
        return this.clients.get(peerId)?.bufferedAmount || 0;
    }

    private handleRequest(req: any, res: any) {
        const CORS_HEADERS = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Device-Id, X-Pin'
        };
        if (req.method === 'OPTIONS') {
            res.writeHead(204, CORS_HEADERS);
            res.end();
            return;
        }

        const pin = req.headers['x-pin'];
        const deviceId = req.headers['x-device-id'] as string || 'unknown';

        if (pin !== this.pin) {
            res.writeHead(403, CORS_HEADERS);
            res.end(JSON.stringify({ error: 'Invalid PIN' }));
            return;
        }

        if (deviceId !== 'unknown') {
            if (!this.clients.has(deviceId)) {
                this.clients.set(deviceId, { lastSeen: Date.now(), queue: [], bufferedAmount: 0 });
            } else {
                this.clients.get(deviceId)!.lastSeen = Date.now();
            }
        }

        if (req.url === '/poll' && req.method === 'GET') {
            res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
            let messagesToSend: any[] = [];
            
            if (deviceId !== 'unknown' && this.clients.has(deviceId)) {
                const client = this.clients.get(deviceId)!;
                messagesToSend = client.queue.splice(0, 500);
                if (client.queue.length === 0) {
                    client.bufferedAmount = 0;
                } else {
                    const sentSize = messagesToSend.reduce((sum, item) => sum + item.size, 0);
                    client.bufferedAmount = Math.max(0, client.bufferedAmount - sentSize);
                }
            }

            const messages = messagesToSend.map(item => {
                let msg = item.data;
                if (msg.type === 'file-update' && msg.encoding === 'binary' && msg.content instanceof ArrayBuffer) {
                    return { ...msg, content: arrayBufferToBase64(msg.content), encoding: 'base64' };
                }
                if (msg.type === 'file-chunk-data' && msg.data instanceof ArrayBuffer) {
                    return { ...msg, data: arrayBufferToBase64(msg.data) };
                }
                return msg;
            });
            res.end(JSON.stringify(messages));
        } else if (req.url === '/push-batch' && req.method === 'POST') {
            let body = '';
            let totalSize = 0;
            const MAX_BODY_SIZE = 100 * 1024 * 1024;
            let destroyed = false;

            req.on('data', (chunk: any) => {
                if (destroyed) return;
                totalSize += chunk.length;
                if (totalSize > MAX_BODY_SIZE) {
                    destroyed = true;
                    res.writeHead(413, CORS_HEADERS);
                    res.end(JSON.stringify({ error: 'Payload too large' }));
                    req.destroy();
                    return;
                }
                body += chunk.toString();
            });
            req.on('end', () => {
                if (destroyed) return;
                try {
                    const messages: any[] = JSON.parse(body);
                    if (!Array.isArray(messages)) throw new Error('Expected array');
                    
                    for (let data of messages) {
                        if (data.type === 'file-update' && data.encoding === 'base64' && typeof data.content === 'string') {
                            data = { ...data, content: base64ToArrayBuffer(data.content), encoding: 'binary' };
                        }
                        if (data.type === 'file-chunk-data' && typeof (data as any).data === 'string') {
                            (data as any).data = base64ToArrayBuffer((data as any).data);
                        }
                        const mockConn = {
                            send: (msg: any) => this.sendTo(deviceId, msg),
                            peer: deviceId !== 'unknown' ? deviceId : 'direct-ip-client',
                            open: true,
                        } as any;
                        this.plugin.handleRawIncomingData(data, mockConn);
                    }
                    res.writeHead(200, CORS_HEADERS);
                    res.end(JSON.stringify({ status: 'ok', count: messages.length }));
                } catch (e) {
                    res.writeHead(400, CORS_HEADERS);
                    res.end(JSON.stringify({ error: 'Invalid data format' }));
                }
            });
        } else if (req.url === '/push' && req.method === 'POST') {
            let body = '';
            let totalSize = 0;
            const MAX_BODY_SIZE = 50 * 1024 * 1024;
            let destroyed = false;

            req.on('data', (chunk: any) => {
                if (destroyed) return;
                totalSize += chunk.length;
                if (totalSize > MAX_BODY_SIZE) {
                    destroyed = true;
                    res.writeHead(413, CORS_HEADERS);
                    res.end(JSON.stringify({ error: 'Payload too large' }));
                    req.destroy();
                    return;
                }
                body += chunk.toString();
            });
            req.on('end', () => {
                if (destroyed) return;
                try {
                    let data: any = JSON.parse(body);
                    if (data.type === 'file-update' && data.encoding === 'base64' && typeof data.content === 'string') {
                         data = { ...data, content: base64ToArrayBuffer(data.content), encoding: 'binary' };
                    }
                    if (data.type === 'file-chunk-data' && typeof (data as any).data === 'string') {
                        (data as any).data = base64ToArrayBuffer((data as any).data);
                    }

                    const mockConn = {
                        send: (msg: any) => this.sendTo(deviceId, msg),
                        peer: deviceId !== 'unknown' ? deviceId : 'direct-ip-client',
                        open: true,
                    } as any;

                    this.plugin.handleRawIncomingData(data, mockConn);
                    res.writeHead(200, CORS_HEADERS);
                    res.end(JSON.stringify({ status: 'ok' }));
                } catch (e) {
                    res.writeHead(400, CORS_HEADERS);
                    res.end(JSON.stringify({ error: 'Invalid data format' }));
                }
            });
        } else {
            res.writeHead(404, CORS_HEADERS);
            res.end();
        }
    }

    send(data: any) {
        const dataStr = JSON.stringify(data);
        const size = dataStr.length;
        for (const client of this.clients.values()) {
            if (client.queue.length >= this.MAX_QUEUE_SIZE) {
                const evicted = client.queue.splice(0, client.queue.length - this.MAX_QUEUE_SIZE + 1);
                const evictedSize = evicted.reduce((sum, item) => sum + item.size, 0);
                client.bufferedAmount = Math.max(0, client.bufferedAmount - evictedSize);
            }
            client.queue.push({ data, size });
            client.bufferedAmount += size;
        }
    }

    stop() {
        if (this.server) {
            this.server.close();
            // Fix: Forcefully close all active client HTTP connections/sockets to prevent port/connection leaks.
            if (typeof this.server.closeAllConnections === 'function') {
                this.server.closeAllConnections();
            }
        }
        this.server = null;
        this.plugin.log("Offline Server stopped.");
    }
}

export class DirectIpClient {
    public isOpen: boolean = false;
    private pollTimeout: number | null = null;
    private baseUrl: string;
    private headers: Record<string, string>;
    private pendingBytes: number = 0;
    private pollInterval: number = 1000;
    private consecutiveEmptyPolls: number = 0;
    private isStopped = false;
    private sendBuffer: any[] = [];
    private sendBufferBytes: number = 0;
    private flushTimeout: number | null = null;
    private isFlushing: boolean = false;
    private readonly FLUSH_INTERVAL_MS = 50;
    private readonly MAX_BUFFER_COUNT = 50;
    private readonly MAX_BUFFER_BYTES = 10 * 1024 * 1024;

    constructor(private plugin: ObsidianDecentralizedPlugin, config: DirectIpConfig) {
        this.baseUrl = `http://${config.host}:${config.port}`;
        this.headers = {
            'Content-Type': 'application/json',
            'X-Device-Id': plugin.settings.deviceId,
            'X-Pin': config.pin,
        };
        this.startPolling();
        this.plugin.showNotice(`Connected to Offline Host at ${config.host}`, 'important', 3000);
    }
    
    getBufferedAmount(): number {
        return this.pendingBytes + this.sendBufferBytes;
    }

    private async poll() {
        if (this.isStopped) return;
        let hasMessages = false;
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/poll`,
                method: 'GET',
                headers: this.headers,
            });
            if (response.status === 200) {
                this.isOpen = true;
                const messages: any[] = response.json;
                if (messages && messages.length > 0) hasMessages = true;
                for (let msg of messages) {
                    if (msg.type === 'file-update' && msg.encoding === 'base64' && typeof msg.content === 'string') {
                        msg = { ...msg, content: base64ToArrayBuffer(msg.content), encoding: 'binary' } as FileUpdatePayload;
                    }
                    if (msg.type === 'file-chunk-data' && typeof (msg as any).data === 'string') {
                        (msg as any).data = base64ToArrayBuffer((msg as any).data);
                    }

                    const mockConn = {
                        send: (data: any) => this.send(data),
                        peer: 'direct-ip-host',
                        open: true
                    } as any;

                    this.plugin.handleRawIncomingData(msg, mockConn);
                }
            }
        } catch (e) {
            this.isOpen = false;
            this.plugin.log('Offline Poll Error:', e);
            this.plugin.updateStatus({ text: 'Host Unreachable', icon: 'server-off', state: 'error' });
        }
        
        if (this.isStopped) return;

        if (hasMessages) {
            this.consecutiveEmptyPolls = 0;
            this.pollInterval = 10;
        } else {
            this.consecutiveEmptyPolls++;
            if (this.consecutiveEmptyPolls > 3) {
                this.pollInterval = Math.min(500, Math.floor(this.pollInterval * 1.5));
            }
        }
        
        this.pollTimeout = window.setTimeout(() => this.poll(), Math.max(10, this.pollInterval));
    }

    async send(data: any) {
        let payloadToSend = data;
        
        if (data.type === 'file-update' && data.encoding === 'binary' && data.content instanceof ArrayBuffer) {
            payloadToSend = { ...data, content: arrayBufferToBase64(data.content), encoding: 'base64' };
        }
        if (data.type === 'file-chunk-data' && data.data instanceof ArrayBuffer) {
            payloadToSend = { ...data, data: arrayBufferToBase64(data.data) } as any;
        }

        const itemStr = JSON.stringify(payloadToSend);
        this.sendBufferBytes += itemStr.length;
        this.sendBuffer.push(payloadToSend);

        if (this.sendBuffer.length >= this.MAX_BUFFER_COUNT || this.sendBufferBytes >= this.MAX_BUFFER_BYTES) {
            await this.flushSendBuffer();
        } else if (!this.flushTimeout) {
            this.flushTimeout = window.setTimeout(() => {
                this.flushTimeout = null;
                this.flushSendBuffer();
            }, this.FLUSH_INTERVAL_MS);
        }
    }

    private async flushSendBuffer() {
        if (this.flushTimeout) {
            clearTimeout(this.flushTimeout);
            this.flushTimeout = null;
        }
        if (this.sendBuffer.length === 0 || this.isFlushing) return;
        
        this.isFlushing = true;
        const batch = this.sendBuffer.splice(0);
        const batchBytes = this.sendBufferBytes;
        this.sendBufferBytes = 0;
        this.pendingBytes += batchBytes;

        try {
            if (batch.length === 1) {
                // Single message: use regular /push for compatibility
                const bodyStr = JSON.stringify(batch[0]);
                await requestUrl({
                    url: `${this.baseUrl}/push`,
                    method: 'POST',
                    headers: this.headers,
                    body: bodyStr,
                });
            } else {
                // Multiple messages: use /push-batch
                const bodyStr = JSON.stringify(batch);
                await requestUrl({
                    url: `${this.baseUrl}/push-batch`,
                    method: 'POST',
                    headers: this.headers,
                    body: bodyStr,
                });
            }
        } catch (e) {
            this.plugin.showNotice('Failed to send data to host.', 'error');
            this.plugin.log('Offline Push Error:', e);
            this.plugin.updateStatus({ text: 'Host Unreachable', icon: 'server-off', state: 'error' });
        } finally {
            this.pendingBytes = Math.max(0, this.pendingBytes - batchBytes);
            this.isFlushing = false;
            // If more messages accumulated while flushing, flush again
            if (this.sendBuffer.length > 0) {
                this.flushSendBuffer();
            }
        }
    }

    startPolling() {
        this.isStopped = false;
        if (this.pollTimeout) clearTimeout(this.pollTimeout);
        this.poll();
    }

    stop() {
        this.isStopped = true;
        this.isOpen = false;
        if (this.pollTimeout) clearTimeout(this.pollTimeout);
        this.pollTimeout = null;
        if (this.flushTimeout) clearTimeout(this.flushTimeout);
        this.flushTimeout = null;
        // Flush remaining messages before stopping
        if (this.sendBuffer.length > 0) {
            this.flushSendBuffer();
        }
        this.plugin.showNotice("Disconnected from Offline Host.", 'important', 3000);
    }
}
