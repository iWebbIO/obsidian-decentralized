import * as dgram from 'dgram';
import * as os from 'os';
import * as http from 'http';
import { EventEmitter } from 'events';
import type { PeerInfo, ILANDiscovery, SyncData } from './main';

const DISCOVERY_PORT = 41234;
const DIRECT_IP_SERVER_PORT = 41236;
const DISCOVERY_MULTICAST_ADDRESS = '224.0.0.114';
const PLUGIN_NAME_PREFIX = 'ObsidianDecentralized';

export function getLocalIp(): string | null {
    try {
        const networkInterfaces = os.networkInterfaces();
        for (const interfaceName in networkInterfaces) {
            const nets = networkInterfaces[interfaceName];
            if (nets) {
                for (const net of nets) {
                    if (net.family === 'IPv4' && !net.internal) return net.address;
                }
            }
        }
    } catch (e) { console.warn(`${PLUGIN_NAME_PREFIX}: Could not determine local IP address.`, e); }
    return null;
}

export class DesktopLANDiscovery implements ILANDiscovery {
    private socket: dgram.Socket | null = null;
    private broadcastInterval: NodeJS.Timeout | null = null;
    private discoveredPeers: Map<string, PeerInfo> = new Map();
    private peerTimeouts: Map<string, NodeJS.Timeout> = new Map();
    private _emitter: EventEmitter;
    constructor() { this._emitter = new EventEmitter(); }
    public on(event: 'discover' | 'lose', listener: (peerInfo: PeerInfo) => void): this { this._emitter.on(event, listener); return this; }
    private emit(event: 'discover' | 'lose', peerInfo: PeerInfo): boolean { return this._emitter.emit(event, peerInfo); }
    private createSocket() { if (this.socket) return; this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true }); this.socket.on('error', (err: Error) => { console.error(`${PLUGIN_NAME_PREFIX}: LAN Discovery Socket Error:`, err); this.stop(); }); this.socket.on('listening', () => { if (!this.socket) return; try { this.socket.addMembership(DISCOVERY_MULTICAST_ADDRESS); this.socket.setMulticastTTL(128); } catch (e) { console.error(`${PLUGIN_NAME_PREFIX}: Error setting up multicast.`, e); } }); this.socket.on('message', (msg, rinfo) => { try { const data = JSON.parse(msg.toString()); if (data.type === 'obsidian-decentralized-beacon' && data.peerInfo?.deviceId) { const peerId = data.peerInfo.deviceId; const existingTimeout = this.peerTimeouts.get(peerId); if (existingTimeout) clearTimeout(existingTimeout); const isNewPeer = !this.discoveredPeers.has(peerId); const peerInfo: PeerInfo = { ...data.peerInfo, ip: rinfo.address }; this.discoveredPeers.set(peerId, peerInfo); if (isNewPeer) this.emit('discover', peerInfo); const timeout = setTimeout(() => { this.discoveredPeers.delete(peerId); this.peerTimeouts.delete(peerId); this.emit('lose', peerInfo); }, 5000); this.peerTimeouts.set(peerId, timeout); } } catch (e) {} }); this.socket.bind(DISCOVERY_PORT); }
    public startBroadcasting(peerInfo: PeerInfo): void { this.stopBroadcasting(); this.createSocket(); const beaconMessage = Buffer.from(JSON.stringify({ type: 'obsidian-decentralized-beacon', peerInfo })); const sendBeacon = () => { this.socket?.send(beaconMessage, DISCOVERY_PORT, DISCOVERY_MULTICAST_ADDRESS, (err) => { if (err) console.error(`${PLUGIN_NAME_PREFIX}: Beacon send error:`, err); }); }; sendBeacon(); this.broadcastInterval = setInterval(sendBeacon, 2000); }
    public stopBroadcasting(): void { if (this.broadcastInterval) { clearInterval(this.broadcastInterval); this.broadcastInterval = null; } }
    public startListening(): void { this.createSocket(); }
    public stop(): void { this.stopBroadcasting(); if (this.socket) { this.socket.close(); this.socket = null; } this.peerTimeouts.forEach(timeout => clearTimeout(timeout)); this.peerTimeouts.clear(); this.discoveredPeers.clear(); }
}

export class DirectIpServer {
    private server: http.Server | null = null;
    private pin: string | null = null;
    private connectedClients: Map<string, { lastSeen: number, updateQueue: SyncData[] }> = new Map();

    constructor(
        private processDataCallback: (data: SyncData[], sourceDeviceId: string) => void,
        private onClientConnected: (peerInfo: PeerInfo) => void,
        private onClientDisconnected: (deviceId: string) => void
    ) {}

    public start(pin: string) {
        if (this.server) this.stop();
        this.pin = pin;

        this.server = http.createServer(this.handleRequest.bind(this));
        this.server.listen(DIRECT_IP_SERVER_PORT, () => {
            console.log(`${PLUGIN_NAME_PREFIX}: Direct IP Server listening on port ${DIRECT_IP_SERVER_PORT}`);
        });
        this.server.on('error', (err) => {
            console.error(`${PLUGIN_NAME_PREFIX}: Direct IP Server error:`, err);
            this.stop();
        });

        setInterval(() => {
            const now = Date.now();
            this.connectedClients.forEach((client, deviceId) => {
                if (now - client.lastSeen > 30000) {
                    this.connectedClients.delete(deviceId);
                    this.onClientDisconnected(deviceId);
                }
            });
        }, 15000);
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        const setCorsHeaders = (response: http.ServerResponse) => {
            response.setHeader('Access-Control-Allow-Origin', '*');
            response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
            response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        };

        setCorsHeaders(res);
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        const body = await new Promise<string>((resolve) => {
            let data = '';
            req.on('data', chunk => data += chunk);
            req.on('end', () => resolve(data));
        });

        let payload;
        try {
            payload = body ? JSON.parse(body) : {};
        } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
        }

        res.setHeader('Content-Type', 'application/json');

        switch (req.url) {
            case '/handshake':
                if (payload.pin === this.pin) {
                    const clientDeviceId = payload.peerInfo.deviceId;
                    this.connectedClients.set(clientDeviceId, { lastSeen: Date.now(), updateQueue: [] });
                    this.onClientConnected(payload.peerInfo);
                    res.writeHead(200);
                    res.end(JSON.stringify({ status: 'ok' }));
                } else {
                    res.writeHead(403);
                    res.end(JSON.stringify({ error: 'Invalid PIN' }));
                }
                break;
            
            case '/sync':
                const clientDeviceId = payload.deviceId;
                if (this.connectedClients.has(clientDeviceId)) {
                    const client = this.connectedClients.get(clientDeviceId)!;
                    client.lastSeen = Date.now();
                    
                    if (payload.updates && payload.updates.length > 0) {
                        this.processDataCallback(payload.updates, clientDeviceId);
                    }
                    
                    const updatesToSend = [...client.updateQueue];
                    client.updateQueue = [];
                    res.writeHead(200);
                    res.end(JSON.stringify({ updates: updatesToSend }));
                } else {
                    res.writeHead(401);
                    res.end(JSON.stringify({ error: 'Not authenticated' }));
                }
                break;

            default:
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Not found' }));
        }
    }

    public enqueueUpdate(data: SyncData) {
        this.connectedClients.forEach(client => {
            client.updateQueue.push(data);
        });
    }

    public stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
            this.connectedClients.clear();
            console.log(`${PLUGIN_NAME_PREFIX}: Direct IP Server stopped.`);
        }
    }
}
