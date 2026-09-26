import { SimulatedNetwork, SimulatedTransport } from '../simulation/SimulatedNetwork';
import { VirtualDevice, waitForConvergence } from '../simulation/VirtualDevice';

describe('Stress Test: Network Chaos & Partition Recovery', () => {
    let network: SimulatedNetwork;
    let devA: VirtualDevice;
    let devB: VirtualDevice;
    let devC: VirtualDevice;
    let trA: SimulatedTransport;
    let trB: SimulatedTransport;
    let trC: SimulatedTransport;

    beforeEach(async () => {
        network = new SimulatedNetwork(0x99AA);
        devA = new VirtualDevice({ deviceId: 'node-A' });
        devB = new VirtualDevice({ deviceId: 'node-B' });
        devC = new VirtualDevice({ deviceId: 'node-C' });

        trA = new SimulatedTransport('node-A', network);
        trB = new SimulatedTransport('node-B', network);
        trC = new SimulatedTransport('node-C', network);

        devA.attachTransport(trA);
        devB.attachTransport(trB);
        devC.attachTransport(trC);

        await devA.connectTo('node-B');
        await devA.connectTo('node-C');
        await devB.connectTo('node-A');
        await devB.connectTo('node-C');
        await devC.connectTo('node-A');
        await devC.connectTo('node-B');
    });

    afterEach(async () => {
        await devA.destroy();
        await devB.destroy();
        await devC.destroy();
        await trA.close();
        await trB.close();
        await trC.close();
    });

    test('recovers from split-brain network partition after healing', async () => {
        // Initial sync state
        await devA.writeFile('common.md', 'Base content');
        await waitForConvergence([devA, devB, devC], 1500);

        expect(await devB.storage.read('common.md')).toBe('Base content');
        expect(await devC.storage.read('common.md')).toBe('Base content');

        // Partition network: {node-A, node-B} vs {node-C}
        network.partition(['node-A', 'node-B'], ['node-C']);

        // Mutations on side 1 (A & B)
        await devA.writeFile('side1.md', 'Written in partition 1');
        await devA.syncWith('node-B');
        await new Promise(r => setTimeout(r, 60));

        // Mutation on side 2 (C)
        await devC.writeFile('side2.md', 'Written in partition 2');
        await devC.syncWith('node-A'); // Should be dropped
        await new Promise(r => setTimeout(r, 60));

        // Node C must not have side1.md yet, and Node A must not have side2.md
        expect(await devC.storage.exists('side1.md')).toBe(false);
        expect(await devA.storage.exists('side2.md')).toBe(false);

        // Heal the partition
        network.heal();

        // Trigger reconciliation sync across all peers
        const converged = await waitForConvergence([devA, devB, devC], 2500);
        expect(converged).toBe(true);

        // All nodes must now have all files
        for (const dev of [devA, devB, devC]) {
            expect(await dev.storage.exists('common.md')).toBe(true);
            expect(await dev.storage.exists('side1.md')).toBe(true);
            expect(await dev.storage.exists('side2.md')).toBe(true);
        }

        const rootA = await devA.getMerkleRoot();
        const rootB = await devB.getMerkleRoot();
        const rootC = await devC.getMerkleRoot();

        expect(rootB).toBe(rootA);
        expect(rootC).toBe(rootA);
    });

    test('converges under packet loss and jitter', async () => {
        // Disconnect devC so this test isolates two peers under network fault injection
        await devA.disconnectFrom('node-C');
        await devB.disconnectFrom('node-C');

        // Configure 10% packet drop and 5-15ms latency jitter
        network.setFaults({
            packetLossRate: 0.10,
            minLatencyMs: 5,
            maxLatencyMs: 15
        });

        await devA.writeFile('resilience.md', 'Packet loss resilient content');
        await devB.writeFile('other.md', 'Another resilient file');

        // Repeated sync passes (simulating retry loops under active chaos)
        for (let pass = 0; pass < 6; pass++) {
            await devA.syncAll();
            await devB.syncAll();
            await new Promise(r => setTimeout(r, 60));
        }

        // Disable faults to settle
        network.setFaults({ packetLossRate: 0, minLatencyMs: 0, maxLatencyMs: 0 });

        // Allow any in-flight delayed timer packets to completely drain
        await new Promise(r => setTimeout(r, 100));

        // Reconcile and wait for convergence
        const converged = await waitForConvergence([devA, devB], 3000);
        expect(converged).toBe(true);

        expect(await devA.storage.exists('other.md')).toBe(true);
        expect(await devB.storage.exists('resilience.md')).toBe(true);

        const rootA = await devA.getMerkleRoot();
        const rootB = await devB.getMerkleRoot();
        expect(rootB).toBe(rootA);
    });
});
