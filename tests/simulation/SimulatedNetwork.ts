import { INetworkTransport, MessageHandler, PeerEventHandler } from '../../src/core/transport/INetworkTransport';

/**
 * Fast, deterministic 32-bit PRNG (Mulberry32).
 * Enables 100% reproducible chaos simulation tests.
 */
export class SeededPRNG {
    private state: number;

    constructor(seed: number = 0x12345678) {
        this.state = seed >>> 0;
    }

    public next(): number {
        let t = (this.state += 0x6D2B79F5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    public nextRange(min: number, max: number): number {
        return min + this.next() * (max - min);
    }
}

export interface NetworkFaultConfig {
    packetLossRate: number; // 0.0 to 1.0
    minLatencyMs: number;
    maxLatencyMs: number;
}

/**
 * In-process virtual network router connecting multiple simulated peers.
 */
export class SimulatedNetwork {
    private endpoints: Map<string, SimulatedTransport> = new Map();
    private partitions: Array<[Set<string>, Set<string>]> = [];
    private faults: NetworkFaultConfig = {
        packetLossRate: 0,
        minLatencyMs: 0,
        maxLatencyMs: 0
    };
    public readonly prng: SeededPRNG;
    public readonly seed: number;

    constructor(seed?: number) {
        this.seed = seed ?? Math.floor(Math.random() * 0x7FFFFFFF);
        this.prng = new SeededPRNG(this.seed);
    }

    public register(peerId: string, transport: SimulatedTransport) {
        this.endpoints.set(peerId, transport);
    }

    public unregister(peerId: string) {
        this.endpoints.delete(peerId);
    }

    public setFaults(faults: Partial<NetworkFaultConfig>) {
        this.faults = { ...this.faults, ...faults };
    }

    public partition(groupA: string[], groupB: string[]) {
        this.partitions.push([new Set(groupA), new Set(groupB)]);
    }

    public heal() {
        this.partitions = [];
    }

    public isPartitioned(from: string, to: string): boolean {
        for (const [a, b] of this.partitions) {
            if ((a.has(from) && b.has(to)) || (b.has(from) && a.has(to))) {
                return true;
            }
        }
        return false;
    }

    public async route(from: string, to: string, message: Uint8Array | string): Promise<void> {
        if (!this.endpoints.has(to)) {
            return; // Destination offline/unreachable
        }

        if (this.isPartitioned(from, to)) {
            // Drop message silently due to network partition
            return;
        }

        if (this.faults.packetLossRate > 0 && this.prng.next() < this.faults.packetLossRate) {
            // Dropped packet
            return;
        }

        const delay = this.faults.maxLatencyMs > 0
            ? this.prng.nextRange(this.faults.minLatencyMs, this.faults.maxLatencyMs)
            : 0;

        const target = this.endpoints.get(to);
        if (!target) return;

        if (delay > 0) {
            setTimeout(() => {
                target.receiveMessage(from, message);
            }, delay);
        } else {
            // Immediate dispatch via microtask to preserve async semantics
            queueMicrotask(() => {
                target.receiveMessage(from, message);
            });
        }
    }

    public disconnect(peerA: string, peerB: string) {
        const epA = this.endpoints.get(peerA);
        const epB = this.endpoints.get(peerB);
        if (epA) epA.handlePeerDisconnected(peerB);
        if (epB) epB.handlePeerDisconnected(peerA);
    }
}

/**
 * Transport implementation wired into the SimulatedNetwork.
 */
export class SimulatedTransport implements INetworkTransport {
    private messageListeners: Set<MessageHandler> = new Set();
    private connectListeners: Set<PeerEventHandler> = new Set();
    private disconnectListeners: Set<PeerEventHandler> = new Set();
    private connectedPeers: Set<string> = new Set();

    constructor(
        public readonly peerId: string,
        private network: SimulatedNetwork
    ) {
        this.network.register(peerId, this);
    }

    public async send(targetPeerId: string, message: Uint8Array | string): Promise<void> {
        await this.network.route(this.peerId, targetPeerId, message);
    }

    public receiveMessage(fromPeerId: string, message: Uint8Array | string) {
        if (!this.connectedPeers.has(fromPeerId)) {
            this.connectedPeers.add(fromPeerId);
            for (const handler of this.connectListeners) {
                try { handler(fromPeerId); } catch (_) {}
            }
        }
        for (const handler of this.messageListeners) {
            try { handler(fromPeerId, message); } catch (_) {}
        }
    }

    public handlePeerDisconnected(peerId: string) {
        if (this.connectedPeers.delete(peerId)) {
            for (const handler of this.disconnectListeners) {
                try { handler(peerId); } catch (_) {}
            }
        }
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
        this.network.disconnect(this.peerId, peerId);
    }

    public getConnectedPeers(): string[] {
        return Array.from(this.connectedPeers);
    }

    public async close(): Promise<void> {
        for (const peer of Array.from(this.connectedPeers)) {
            await this.disconnect(peer);
        }
        this.network.unregister(this.peerId);
    }
}
