import { AddressInfo } from 'net';
import { INetworkTransport, MessageHandler, PeerEventHandler } from '../../src/core/transport/INetworkTransport';

// Directly reference real node_modules/ws to prevent Jest mock interception
// @ts-ignore
const wsModule = require('../../node_modules/ws');
const WebSocketServer = wsModule.WebSocketServer || wsModule.Server;
const WebSocket = wsModule.WebSocket || wsModule;

/**
 * Loopback socket transport backed by real Node.js ws WebSockets on 127.0.0.1.
 * Tests wire serialization, TCP socket buffers, and real OS network backpressure.
 */
export class LoopbackTransport implements INetworkTransport {
    private wss: any = null;
    private port: number = 0;
    private connections: Map<string, any> = new Map();
    private allSockets: Set<any> = new Set();
    private messageListeners: Set<MessageHandler> = new Set();
    private connectListeners: Set<PeerEventHandler> = new Set();
    private disconnectListeners: Set<PeerEventHandler> = new Set();

    constructor(public readonly peerId: string) {}

    public async listen(): Promise<number> {
        return new Promise((resolve, reject) => {
            this.wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => {
                const addr = this.wss!.address() as AddressInfo;
                this.port = addr.port;

                this.wss!.on('connection', (ws: any, req: any) => {
                    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
                    const remotePeerId = url.searchParams.get('peerId') || `unknown-${Date.now()}`;
                    this.setupSocket(remotePeerId, ws);
                });

                resolve(this.port);
            });

            this.wss.on('error', reject);
        });
    }

    public getPort(): number {
        return this.port;
    }

    public async connect(targetPeerId: string, targetPort: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${targetPort}?peerId=${encodeURIComponent(this.peerId)}`);

            ws.on('open', () => {
                this.setupSocket(targetPeerId, ws);
                resolve();
            });

            ws.on('error', reject);
        });
    }

    private setupSocket(peerId: string, ws: any) {
        this.allSockets.add(ws);
        this.connections.set(peerId, ws);

        for (const handler of this.connectListeners) {
            try { handler(peerId); } catch (_) {}
        }

        ws.on('message', (data: Buffer | string) => {
            for (const handler of this.messageListeners) {
                try { handler(peerId, data.toString()); } catch (_) {}
            }
        });

        ws.on('close', () => {
            this.allSockets.delete(ws);
            this.connections.delete(peerId);
            for (const handler of this.disconnectListeners) {
                try { handler(peerId); } catch (_) {}
            }
        });

        ws.on('error', () => {
            this.allSockets.delete(ws);
            this.connections.delete(peerId);
        });
    }

    public async send(peerId: string, message: Uint8Array | string): Promise<void> {
        const ws = this.connections.get(peerId);
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error(`Socket not connected to peer: ${peerId}`);
        }

        return new Promise((resolve, reject) => {
            ws.send(message, (err: any) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    public onMessage(handler: MessageHandler): () => void {
        this.messageListeners.add(handler);
        return () => this.messageListeners.delete(handler);
    }

    public onPeerConnect(handler: PeerEventHandler): () => void {
        this.connectListeners.add(handler);
        return () => this.connectListeners.delete(handler);
    }

    public onPeerDisconnect(handler: PeerEventHandler): () => void {
        this.disconnectListeners.add(handler);
        return () => this.disconnectListeners.delete(handler);
    }

    public async disconnect(peerId: string): Promise<void> {
        const ws = this.connections.get(peerId);
        if (ws) {
            ws.close();
            this.allSockets.delete(ws);
            this.connections.delete(peerId);
        }
    }

    public getConnectedPeers(): string[] {
        return Array.from(this.connections.keys());
    }

    public async close(): Promise<void> {
        for (const ws of this.allSockets) {
            try {
                if (typeof ws.terminate === 'function') ws.terminate();
                else ws.close();
            } catch (_) {}
        }
        this.allSockets.clear();
        this.connections.clear();

        if (this.wss) {
            if (this.wss.clients) {
                for (const client of this.wss.clients) {
                    try {
                        if (typeof client.terminate === 'function') client.terminate();
                        else client.close();
                    } catch (_) {}
                }
            }
            await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
            this.wss = null;
        }
    }
}
