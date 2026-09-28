import { Notice } from 'obsidian';
import { ILANDiscovery, PeerInfo, DiscoveryBeacon, DISCOVERY_PORT, DISCOVERY_MULTICAST_ADDRESS } from './types';
import { sanitizePeerInfo } from './utils/pairing';
import { PSK_PATTERN } from './utils/pairing';

export class DummyLANDiscovery implements ILANDiscovery {
    on(event: string, listener: (...args: any[]) => void): this { return this; }
    off(event: string, listener: (...args: any[]) => void): this { return this; }
    startBroadcasting(peerInfo: PeerInfo): void { }
    stopBroadcasting(): void { }
    startListening(): void { }
    stop(): void { }
    getDiscoveredPeers(): PeerInfo[] { return []; }
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
    private socketRestartAttempts: number = 0;
    private restartTimeout: number | null = null;
    private isRestarting: boolean = false;
    
    private onNetworkChange = () => {
        if (this.isRestarting) return;
        this.isRestarting = true;
        console.log('Network interface change detected, restarting LAN discovery...');
        const wasBroadcasting = this.broadcastTimer !== null;
        this.stopBroadcasting();
        if (this.socket) {
            // Close unconditionally: a socket that is still binding must be closed too,
            // otherwise it leaks — it finishes binding later and keeps emitting
            // discover/lose events forever alongside its replacement.
            try { this.socket.close(); } catch (_) {}
            this.socket = null;
        }
        this.socketRestartAttempts = 0;
        if (wasBroadcasting && this.lastPeerInfo) {
            this.startBroadcasting(this.lastPeerInfo);
            this.startListening();
        } else {
            this.startListening();
        }
        // NOTE: the event is NOT forwarded. main.ts attaches its own window
        // online/offline listeners, and forwarding made every OS network change run
        // the handler twice back-to-back — for direct-ip, that restarted the
        // just-armed reconnect on each event.
        this.isRestarting = false;
    };

    private setupNetworkChangeListeners() {
        if (!this.hasNetworkListeners && typeof window !== 'undefined') {
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
                try { this.socket.close(); } catch (_) {}
                this.socket = null;
            }
            
            this.socketRestartAttempts++;
            // Infinite backoff capping at 10000ms ensures it's fully self-healing and plug-and-play
            const delay = Math.min(10000, this.socketRestartAttempts * 2000);
            console.log(`LAN Discovery: scheduling socket restart attempt in ${delay}ms`);
            
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
        });

        this.socket.on('listening', () => {
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
                new Notice("Nearby devices may not appear. Paste the pairing code.");
            }
        });

        this.socket.on('message', (msg: Buffer, rinfo: any) => {
            try {
                const data: DiscoveryBeacon = JSON.parse(msg.toString());
                if (data.type === 'obsidian-decentralized-beacon' && data.peerInfo?.deviceId) {
                    // The beacon's peerInfo is the one inbound peer source not run
                    // through sanitizePeerInfo: its fields go straight into the UI
                    // and (for a discovered host's port) into the join settings, so
                    // a hostile or buggy peer on the LAN could steer them.
                    const clean = sanitizePeerInfo(data.peerInfo);
                    if (!clean) return;
                    const pairingKey = typeof data.peerInfo.pairingKey === 'string' && PSK_PATTERN.test(data.peerInfo.pairingKey)
                        ? data.peerInfo.pairingKey : undefined;

                    const peerId = clean.deviceId;
                    if (this.myDeviceId && peerId === this.myDeviceId) return;

                    if (this.peerTimeouts.has(peerId)) {
                        clearTimeout(this.peerTimeouts.get(peerId)!);
                    }

                    const prev = this.discoveredPeers.get(peerId);
                    const isNew = !prev;
                    const cur = { ...clean, ip: rinfo.address, pairingKey };
                    this.discoveredPeers.set(peerId, cur);
                    // Re-emit when anything a connection decision depends on changes —
                    // not just the pairing key. A desktop that starts hosting after
                    // this list opened re-broadcasts with mode/port filled in; without
                    // the re-emit, the stale port-less copy kept the host out of the
                    // Discovered Hosts list until the modal was reopened, and a DHCP
                    // renew filled the join box with a dead address.
                    const changed = !!prev && (
                        prev.pairingKey !== cur.pairingKey
                        || prev.port !== cur.port
                        || prev.mode !== cur.mode
                        || prev.ip !== cur.ip
                    );
                    if (isNew || changed) {
                        if (isNew) this.currentBroadcastIntervalMs = 2000;
                        this.emit('discover', cur);
                    }

                    const timeout = setTimeout(() => {
                        const info = this.discoveredPeers.get(peerId);
                        this.discoveredPeers.delete(peerId);
                        this.peerTimeouts.delete(peerId);
                        if (info) this.emit('lose', info);
                    }, this.discoveryTimeoutMs) as any as number;
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

        this.currentBroadcastIntervalMs = 2000;
        this.consecutiveErrors = 0;

        const sendBeacon = () => {
            if (!this.lastPeerInfo) return;
            const beaconMessage = JSON.stringify({
                type: 'obsidian-decentralized-beacon',
                peerInfo: this.lastPeerInfo
            });
            const beaconBuffer = Buffer.from(beaconMessage);
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
            // Cap the ramp at 3 s: against the 15 s peer-expiry, a 5 s steady state
            // tolerates only two lost multicast beacons (no MAC-layer retries) before
            // a device flickers out of the Nearby list.
            if (this.currentBroadcastIntervalMs < 3000) {
                this.currentBroadcastIntervalMs += 1000;
            }
            this.broadcastTimer = setTimeout(sendBeacon, this.currentBroadcastIntervalMs) as any as number;
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

    /** Peers currently known to discovery. Lets late-attaching listeners (e.g. a
     *  freshly opened pairing modal) see peers whose 'discover' event already fired. */
    public getDiscoveredPeers(): PeerInfo[] {
        return Array.from(this.discoveredPeers.values());
    }

    public stop() {
        this.stopBroadcasting();
        if (this.restartTimeout !== null) {
            clearTimeout(this.restartTimeout);
            this.restartTimeout = null;
        }
        this.socketRestartAttempts = 0;

        if (this.hasNetworkListeners && typeof window !== 'undefined') {
            window.removeEventListener('online', this.onNetworkChange);
            window.removeEventListener('offline', this.onNetworkChange);
            this.hasNetworkListeners = false;
        }

        if (this.socket) {
            try {
                this.socket.close();
            } catch (e) {
                console.error('Error closing LAN discovery socket:', e);
            }
            this.socket = null;
        }
        this.discoveredPeers.forEach((peerInfo, peerId) => {
            this.emit('lose', peerInfo);
        });
        this.discoveredPeers.clear();
        this.peerTimeouts.forEach(timeout => clearTimeout(timeout));
        this.peerTimeouts.clear();
        console.log('LAN Discovery stopped.');
    }
}
