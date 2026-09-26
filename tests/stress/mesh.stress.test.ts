import { SimulatedNetwork, SimulatedTransport } from '../simulation/SimulatedNetwork';
import { VirtualDevice } from '../simulation/VirtualDevice';

describe('Stress Test: Multi-Peer Mesh Convergence', () => {
    const NUM_DEVICES = 5;
    let network: SimulatedNetwork;
    let devices: VirtualDevice[];
    let transports: SimulatedTransport[];

    beforeEach(async () => {
        network = new SimulatedNetwork(0xCAFE);
        devices = [];
        transports = [];

        for (let i = 0; i < NUM_DEVICES; i++) {
            const id = `node-${i + 1}`;
            const dev = new VirtualDevice({ deviceId: id });
            const tr = new SimulatedTransport(id, network);
            dev.attachTransport(tr);
            devices.push(dev);
            transports.push(tr);
        }

        // Connect in full mesh
        for (let i = 0; i < NUM_DEVICES; i++) {
            for (let j = 0; j < NUM_DEVICES; j++) {
                if (i !== j) {
                    await devices[i].connectTo(devices[j].deviceId);
                }
            }
        }
    });

    afterEach(async () => {
        for (const dev of devices) await dev.destroy();
        for (const tr of transports) await tr.close();
    });

    test('5 concurrent peers converge to identical Merkle roots with concurrent writes', async () => {
        // Concurrently write different files across all 5 nodes
        await Promise.all([
            devices[0].writeFile('node1-notes.md', 'Content from Node 1'),
            devices[0].writeFile('shared-knowledge.md', 'Knowledge base initialized by Node 1'),
            devices[1].writeFile('node2-notes.md', 'Content from Node 2'),
            devices[1].writeBinary('assets/data.bin', new Uint8Array([1, 2, 3, 4, 5]).buffer),
            devices[2].writeFile('node3-notes.md', 'Content from Node 3'),
            devices[2].writeFile('deep/nested/path/spec.md', 'Nested spec from Node 3'),
            devices[3].writeFile('node4-notes.md', 'Content from Node 4'),
            devices[4].writeFile('node5-notes.md', 'Content from Node 5')
        ]);

        // Trigger full sync exchange across the mesh
        for (const dev of devices) {
            await dev.syncAll();
        }

        // Allow microtasks and message dispatch to settle
        await new Promise(r => setTimeout(r, 200));

        // Trigger secondary gossip reconciliation pass
        for (const dev of devices) {
            await dev.syncAll();
        }
        await new Promise(r => setTimeout(r, 200));

        // 1. Verify every device has the same Merkle root hash
        const roots = await Promise.all(devices.map(d => d.getMerkleRoot()));
        const canonicalRoot = roots[0];
        expect(canonicalRoot).toBeTruthy();

        for (let i = 1; i < NUM_DEVICES; i++) {
            expect(roots[i]).toBe(canonicalRoot);
        }

        // 2. Verify all files exist on all devices with identical content
        const expectedFiles = [
            'node1-notes.md',
            'shared-knowledge.md',
            'node2-notes.md',
            'assets/data.bin',
            'node3-notes.md',
            'deep/nested/path/spec.md',
            'node4-notes.md',
            'node5-notes.md'
        ];

        for (const dev of devices) {
            for (const file of expectedFiles) {
                const exists = await dev.storage.exists(file);
                expect(exists).toBe(true);
            }
            const sharedText = await dev.storage.read('shared-knowledge.md');
            expect(sharedText).toBe('Knowledge base initialized by Node 1');

            const binData = await dev.storage.readBinary('assets/data.bin');
            expect(new Uint8Array(binData)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
        }
    });
});
