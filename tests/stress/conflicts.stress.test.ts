import { SimulatedNetwork, SimulatedTransport } from '../simulation/SimulatedNetwork';
import { VirtualDevice } from '../simulation/VirtualDevice';

describe('Stress Test: Concurrent Conflict Resolution', () => {
    let network: SimulatedNetwork;
    let devA: VirtualDevice;
    let devB: VirtualDevice;
    let trA: SimulatedTransport;
    let trB: SimulatedTransport;

    beforeEach(async () => {
        network = new SimulatedNetwork(0xBEEF);
        devA = new VirtualDevice({ deviceId: 'node-A', conflictStrategy: 'three-way-merge', role: 'primary' });
        devB = new VirtualDevice({ deviceId: 'node-B', conflictStrategy: 'three-way-merge', role: 'secondary' });

        trA = new SimulatedTransport('node-A', network);
        trB = new SimulatedTransport('node-B', network);

        devA.attachTransport(trA);
        devB.attachTransport(trB);

        await devA.connectTo('node-B');
        await devB.connectTo('node-A');
    });

    afterEach(async () => {
        await devA.destroy();
        await devB.destroy();
        await trA.close();
        await trB.close();
    });

    test('cleanly performs 3-way text merge on concurrent non-overlapping edits', async () => {
        const base = "Title\nSection A\nSection B\nFooter";
        await devA.writeFile('document.md', base);
        await devA.syncWith('node-B');
        await new Promise(r => setTimeout(r, 60));

        // Partition network to simulate offline/concurrent edits before sync
        network.partition(['node-A'], ['node-B']);

        // Concurrent edits on separate sections
        await devA.writeFile('document.md', "Title\nSection A [Node A Edit]\nSection B\nFooter");
        await devB.writeFile('document.md', "Title\nSection A\nSection B [Node B Edit]\nFooter");

        // Heal network and sync both ways
        network.heal();
        await devA.syncWith('node-B');
        await devB.syncWith('node-A');
        await new Promise(r => setTimeout(r, 80));

        // Second pass to settle
        await devA.syncWith('node-B');
        await devB.syncWith('node-A');
        await new Promise(r => setTimeout(r, 80));

        const contentA = await devA.storage.read('document.md');
        const contentB = await devB.storage.read('document.md');

        expect(contentA).toContain('[Node A Edit]');
        expect(contentA).toContain('[Node B Edit]');
        expect(contentB).toContain('[Node A Edit]');
        expect(contentB).toContain('[Node B Edit]');
    });

    test('creates conflict file safely on concurrent binary edits without data loss', async () => {
        const baseBinary = new Uint8Array([0, 0, 0, 0]).buffer;
        await devA.writeBinary('image.png', baseBinary);
        await devA.syncWith('node-B');
        await new Promise(r => setTimeout(r, 60));

        // Partition network to simulate concurrent offline binary edits
        network.partition(['node-A'], ['node-B']);

        // Concurrent binary edits
        const editA = new Uint8Array([1, 1, 1, 1]).buffer;
        const editB = new Uint8Array([2, 2, 2, 2]).buffer;

        await devA.writeBinary('image.png', editA);
        await devB.writeBinary('image.png', editB);

        // Heal and sync both ways
        network.heal();
        await devA.syncWith('node-B');
        await devB.syncWith('node-A');
        await new Promise(r => setTimeout(r, 80));

        // Verify conflict file was generated
        const filesA = await devA.storage.listFiles();
        const filesB = await devB.storage.listFiles();

        const conflictFileA = filesA.find(f => f.path.includes('.conflict-'));
        const conflictFileB = filesB.find(f => f.path.includes('.conflict-'));

        // At least one device generated a conflict file to prevent overwriting
        expect(conflictFileA || conflictFileB).toBeDefined();

        // Original image.png still exists on both
        expect(await devA.storage.exists('image.png')).toBe(true);
        expect(await devB.storage.exists('image.png')).toBe(true);
    });
});
