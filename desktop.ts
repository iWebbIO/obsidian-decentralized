import * as dgram from 'dgram';
import * as os from 'os';
import { EventEmitter } from 'events';
import type { PeerInfo, ILANDiscovery } from './main';

const DISCOVERY_PORT = 41234;
const DISCOVERY_MULTICAST_ADDRESS = '224.0.0.114';

export function getLocalIp(): string | null {
    try {
        const interfaces = os.networkInterfaces();
        for (const name in interfaces) {
            for (const net of interfaces[name]!) {
                if (net.family === 'IPv4' && !net.internal) {
                    return net.address;
                }
            }
        }
    } catch (e) {
        console.warn("Could not get local IP address.", e);
    }
    return null;
}

export class DesktopLANDiscovery implements ILANDiscovery {
    private socket: dgram.Socket | null = null;
    private broadcastInterval: number | null = null;
    private discoveredPeers: Map<string, PeerInfo> = new Map();
    private peerTimeouts: Map<string, number> = new Map();
    private readonly discoveryTimeoutMs: number = 5000;
    private _emitter: EventEmitter;

    constructor() {
        this._emitter = new EventEmitter();
    }

    public on(event: string, listener: (...args: any[]) => void): this {
        this._emitter.on(event, listener);
        return this;
    }

    private emit(event: string, ...args: any[]): boolean {
        return this._emitter.emit(event, ...args);
    }

    private createSocket() {
        if (this.socket) return;
        
        this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        this.socket.on('error', (err: Error) => {
            console.error('LAN Discovery Socket Error:', err);
            this.stop();
        });

        this.socket.on('listening', () => {
            try {
                this.socket?.addMembership(DISCOVERY_MULTICAST_ADDRESS);
                this.socket?.setMulticastTTL(128);
                console.log(`LAN Discovery listening on ${DISCOVERY_MULTICAST_ADDRESS}:${DISCOVERY_PORT}`);
            } catch (e) {
                console.error("Error setting up multicast:", e);
            }
        });

        this.socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
            try {
                const data = JSON.parse(msg.toString());
                if (data.type === 'obsidian-decentralized-beacon' && data.peerInfo?.deviceId) {
                    const peerId = data.peerInfo.deviceId;

                    if (this.peerTimeouts.has(peerId)) {
                        clearTimeout(this.peerTimeouts.get(peerId)!);
                    }

                    const isNew = !this.discoveredPeers.has(peerId);
                    data.peerInfo.ip = rinfo.address;
                    this.discoveredPeers.set(peerId, data.peerInfo);
                    if (isNew) {
                        this.emit('discover', data.peerInfo);
                    }
                    
                    const timeout = window.setTimeout(() => {
                        this.discoveredPeers.delete(peerId);
                        this.peerTimeouts.delete(peerId);
                        this.emit('lose', data.peerInfo);
                    }, this.discoveryTimeoutMs);
                    this.peerTimeouts.set(peerId, timeout);
                }
            } catch (e) { /* Ignore parsing errors */ }
        });

        this.socket.bind(DISCOVERY_PORT);
    }

    public startBroadcasting(peerInfo: PeerInfo): void {
        this.stopBroadcasting(); 
        this.createSocket();
        
        const beaconMessage = JSON.stringify({
            type: 'obsidian-decentralized-beacon',
            peerInfo
        });

        const sendBeacon = () => {
            this.socket?.send(beaconMessage, 0, beaconMessage.length, DISCOVERY_PORT, DISCOVERY_MULTICAST_ADDRESS, (err) => {
                if (err) console.error("Beacon send error:", err);
            });
        };
        
        sendBeacon(); 
        this.broadcastInterval = window.setInterval(sendBeacon, 2000); 
    }
    
    public stopBroadcasting(): void {
        if (this.broadcastInterval) {
            clearInterval(this.broadcastInterval);
            this.broadcastInterval = null;
        }
    }
    
    public startListening(): void {
        this.createSocket();
    }

    public stop(): void {
        this.stopBroadcasting();
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        this.discoveredPeers.clear();
        this.peerTimeouts.forEach(timeout => clearTimeout(timeout));
        this.peerTimeouts.clear();
        console.log('LAN Discovery stopped.');
    }
}