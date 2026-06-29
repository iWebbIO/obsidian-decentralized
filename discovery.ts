import { Notice } from 'obsidian';
import { ILANDiscovery, PeerInfo, DiscoveryBeacon, DISCOVERY_PORT, DISCOVERY_MULTICAST_ADDRESS } from './types';

export class DummyLANDiscovery implements ILANDiscovery {
    on(event: string, listener: (...args: any[]) => void): this { return this; }
    off(event: string, listener: (...args: any[]) => void): this { return this; }
    startBroadcasting(peerInfo: PeerInfo): void { }
    stopBroadcasting(): void { }
    startListening(): void { }
    stop(): void { }
}

export class DesktopLANDiscovery implements ILANDiscovery {
    private socket: any | null = null;
    private discoveredPeers: Map<string, PeerInfo> = new Map();
    private peerTimeouts: Map<string, number> = new Map();
    private discoveryTimeoutMs: number = 15000; // Increased to 15s to tolerate packet loss
    private _emitter: any;
    private myDeviceId: string | null = null;
    private currentBroadcastIntervalMs: number = 2000;
    private consecutiveErrors: number = 0;
    private broadcastTimer: number | null = null;
    private lastPeerInfo: PeerInfo | null = null;
    private hasNetworkListeners: boolean = false;
    private isBound: boolean = false;
    private socketRestartAttempts: number = 0;
    private maxSocketRestartAttempts: number = 5;
    private restartTimeout: number | null = null;
    
    private onNetworkChange = () => {
        console.log('Network interface change detected, restarting LAN discovery...');
        const wasBroadcasting = this.broadcastTimer !== null;
        this.stop();
        if (wasBroadcasting && this.lastPeerInfo) {
            this.startBroadcasting(this.lastPeerInfo);
            this.startListening();
        } else {
            this.startListening();
        }
        // Forward the event so the plugin can respond (Phase 3.2)
        this.emit('network-change');
    };

    private setupNetworkChangeListeners() {
        if (!this.hasNetworkListeners) {
            window.addEventListener('online', this.onNetworkChange);
            window.addEventListener('offline', this.onNetworkChange);
            this.hasNetworkListeners = true;
        }
    }

    constructor() {
        const { EventEmitter } = require('events');
        this._emitter = new EventEmitter();
    }

    public on(event: string, listener: (...args: any[]) => void): this {
        this._emitter.on(event, listener);
        return this;
    }

    public off(event: string, listener: (...args: any[]) => void): this {
        this._emitter.removeListener(event, listener);
        return this;
    }

    private emit(event: string, ...args: any[]): boolean {
        return this._emitter.emit(event, ...args);
    }

    private createSocket() {
        if (this.socket) return;
        this.setupNetworkChangeListeners();

        const dgram = require('dgram');
        this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        this.socket.on('error', (err: Error) => {
            console.error('LAN Discovery Socket Error:', err);
            
            // Clean up the socket immediately but do not completely cease network change listeners
            if (this.socket) {
                if (this.isBound) {
                    try { this.socket.close(); } catch (_) {}
                }
                this.socket = null;
                this.isBound = false;
            }
            
            if (this.socketRestartAttempts < this.maxSocketRestartAttempts) {
                this.socketRestartAttempts++;
                const delay = Math.min(10000, this.socketRestartAttempts * 2000);
                console.log(`LAN Discovery: scheduling socket restart attempt ${this.socketRestartAttempts}/${this.maxSocketRestartAttempts} in ${delay}ms`);
                
                if (this.restartTimeout !== null) {
                    clearTimeout(this.restartTimeout);
                }
                this.restartTimeout = window.setTimeout(() => {
                    this.restartTimeout = null;
                    if (this.lastPeerInfo) {
                        this.startBroadcasting(this.lastPeerInfo);
                    } else {
                        this.startListening();
                    }
                }, delay);
            } else {
                new Notice('LAN discovery failed. Your firewall might be blocking it.', 10000);
                this.stop();
            }
        });

        this.socket.on('listening', () => {
            this.isBound = true;
            this.socketRestartAttempts = 0;
            if (this.restartTimeout !== null) {
                clearTimeout(this.restartTimeout);
                this.restartTimeout = null;
            }
            try {
                this.socket?.setMulticastTTL(128);

                const os = require('os');
                const interfaces = os.networkInterfaces();
                let membershipAdded = false;

                for (const name in interfaces) {
                    const ifaceList = interfaces[name];
                    if (!ifaceList) continue;
                    for (const net of ifaceList) {
                        if (net.family === 'IPv4' && !net.internal) {
                            try {
                                this.socket?.addMembership(DISCOVERY_MULTICAST_ADDRESS, net.address);
                                membershipAdded = true;
                            } catch (e) { /* Ignore specific interface errors */ }
                        }
                    }
                }

                if (!membershipAdded) this.socket?.addMembership(DISCOVERY_MULTICAST_ADDRESS);

                console.log(`LAN Discovery listening on ${DISCOVERY_MULTICAST_ADDRESS}:${DISCOVERY_PORT}`);
            } catch (e) {
                console.error("Error setting up multicast:", e);
                new Notice("Could not set up multicast. LAN discovery might not work.");
            }
        });

        this.socket.on('message', (msg: Buffer, rinfo: any) => {
            try {
                const data: DiscoveryBeacon = JSON.parse(msg.toString());
                if (data.type === 'obsidian-decentralized-beacon' && data.peerInfo?.deviceId) {
                    const peerId = data.peerInfo.deviceId;
                    if (this.myDeviceId && peerId === this.myDeviceId) return;

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
            } catch (e: any) {
                console.warn('LAN Discovery: Error parsing incoming message:', e);
            }
        });

        this.socket.bind(DISCOVERY_PORT, '0.0.0.0');
    }

    public startBroadcasting(peerInfo: PeerInfo) {
        this.lastPeerInfo = peerInfo;
        this.myDeviceId = peerInfo.deviceId;
        this.stopBroadcasting();
        this.createSocket();

        const beaconMessage = JSON.stringify({
            type: 'obsidian-decentralized-beacon',
            peerInfo
        });

        this.currentBroadcastIntervalMs = 2000;
        this.consecutiveErrors = 0;

        const beaconBuffer = Buffer.from(beaconMessage);
        const sendBeacon = () => {
            this.socket?.send(beaconBuffer, 0, beaconBuffer.length, DISCOVERY_PORT, DISCOVERY_MULTICAST_ADDRESS, (err: Error | null) => {
                if (err) {
                    this.consecutiveErrors++;
                    if (this.consecutiveErrors <= 3) {
                        console.error("Beacon send error:", err);
                    } else {
                        console.warn(`LAN Discovery: Beacon send error (consecutive: ${this.consecutiveErrors}): ${err.message || err}`);
                    }
                } else {
                    this.consecutiveErrors = 0;
                }
            });
            if (this.currentBroadcastIntervalMs < 15000) {
                this.currentBroadcastIntervalMs += 1000;
            }
            this.broadcastTimer = window.setTimeout(sendBeacon, this.currentBroadcastIntervalMs);
        };
        sendBeacon();
    }

    public stopBroadcasting() {
        if (this.broadcastTimer) {
            clearTimeout(this.broadcastTimer);
            this.broadcastTimer = null;
        }
    }

    public startListening() {
        this.createSocket();
    }

    public stop() {
        this.stopBroadcasting();
        if (this.restartTimeout !== null) {
            clearTimeout(this.restartTimeout);
            this.restartTimeout = null;
        }
        this.socketRestartAttempts = 0;

        if (this.hasNetworkListeners) {
            window.removeEventListener('online', this.onNetworkChange);
            window.removeEventListener('offline', this.onNetworkChange);
            this.hasNetworkListeners = false;
        }

        if (this.socket) {
            if (this.isBound) {
                try {
                    this.socket.close();
                } catch (e) {
                    console.error('Error closing LAN discovery socket:', e);
                }
            }
            this.socket = null;
            this.isBound = false;
        }
        this.discoveredPeers.clear();
        this.peerTimeouts.forEach(timeout => clearTimeout(timeout));
        this.peerTimeouts.clear();
        console.log('LAN Discovery stopped.');
    }
}
