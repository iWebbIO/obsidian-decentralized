import { SimulatedNetwork, SimulatedTransport } from '../simulation/SimulatedNetwork';
import { VirtualDevice } from '../simulation/VirtualDevice';

describe('Stress Test: High-Volume Filesystem Churn', () => {
    let network: SimulatedNetwork;
    let devA: VirtualDevice;
    let devB: VirtualDevice;
    let trA: SimulatedTransport;
    let trB: SimulatedTransport;

    beforeEach(async () => {
        network = new SimulatedNetwork(0x7777);
        devA = new VirtualDevice({ deviceId: 'churn-A' });
        devB = new VirtualDevice({ deviceId: 'churn-B' });

        trA = new SimulatedTransport('churn-A', network);
        trB = new SimulatedTransport('churn-B', network);

        devA.attachTransport(trA);
        devB.attachTransport(trB);

        await devA.connectTo('churn-B');
        await devB.connectTo('churn-A');
    });

    afterEach(async () => {
        await devA.destroy();
        await devB.destroy();
        await trA.close();
        await trB.close();
    });

    test('burst creation of 100 files syncs completely and reaches identical Merkle root', async () => {
        const fileCount = 100;
        const promises: Promise<void>[] = [];

        for (let i = 0; i < fileCount; i++) {
            const folder = i % 5 === 0 ? `folder-${i % 10}/` : '';
            promises.push(devA.writeFile(`${folder}file-${i}.txt`, `Burst content index ${i}`));
        }

        await Promise.all(promises);

        // Allow updates to propagate
        await new Promise(r => setTimeout(r, 200));

        // Reconcile
        await devA.syncWith('churn-B');
        await devB.syncWith('churn-A');
        await new Promise(r => setTimeout(r, 200));

        const filesA = await devA.storage.listFiles();
        const filesB = await devB.storage.listFiles();

        expect(filesA.length).toBe(fileCount);
        expect(filesB.length).toBe(fileCount);

        const rootA = await devA.getMerkleRoot();
        const rootB = await devB.getMerkleRoot();
        expect(rootB).toBe(rootA);
    });

    test('handles rapid folder renames and delete-recreate cycles', async () => {
        // Setup initial folder with multiple files
        await devA.writeFile('archive/2026/report.md', 'Initial Report');
        await devA.writeFile('archive/2026/summary.md', 'Initial Summary');
        await devA.syncWith('churn-B');
        await new Promise(r => setTimeout(r, 80));

        // Rename folder on Node A
        await devA.renameFile('archive/2026', 'archive/2026-final');
        await new Promise(r => setTimeout(r, 80));

        expect(await devB.storage.exists('archive/2026-final/report.md')).toBe(true);
        expect(await devB.storage.exists('archive/2026-final/summary.md')).toBe(true);

        // Rapid delete and recreate on Node B
        await devB.deleteFile('archive/2026-final/report.md');
        await devB.writeFile('archive/2026-final/report.md', 'Recreated Report Fresh');
        await new Promise(r => setTimeout(r, 80));

        expect(await devA.storage.read('archive/2026-final/report.md')).toBe('Recreated Report Fresh');

        const rootA = await devA.getMerkleRoot();
        const rootB = await devB.getMerkleRoot();
        expect(rootB).toBe(rootA);
    });
});
