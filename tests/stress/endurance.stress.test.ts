import { SimulatedNetwork, SimulatedTransport, SeededPRNG } from '../simulation/SimulatedNetwork';
import { VirtualDevice, waitForConvergence } from '../simulation/VirtualDevice';

describe('Stress Test: Randomized Endurance & Fuzzing', () => {
    const SEED = parseInt(process.env.STRESS_SEED || '0x5EED1234', 16);
    const ITERATIONS = parseInt(process.env.STRESS_ITERATIONS || '50', 10);

    let network: SimulatedNetwork;
    let dev1: VirtualDevice;
    let dev2: VirtualDevice;
    let dev3: VirtualDevice;
    let tr1: SimulatedTransport;
    let tr2: SimulatedTransport;
    let tr3: SimulatedTransport;

    beforeEach(async () => {
        network = new SimulatedNetwork(SEED);
        dev1 = new VirtualDevice({ deviceId: 'fuzz-1' });
        dev2 = new VirtualDevice({ deviceId: 'fuzz-2' });
        dev3 = new VirtualDevice({ deviceId: 'fuzz-3' });

        tr1 = new SimulatedTransport('fuzz-1', network);
        tr2 = new SimulatedTransport('fuzz-2', network);
        tr3 = new SimulatedTransport('fuzz-3', network);

        dev1.attachTransport(tr1);
        dev2.attachTransport(tr2);
        dev3.attachTransport(tr3);

        await dev1.connectTo('fuzz-2');
        await dev1.connectTo('fuzz-3');
        await dev2.connectTo('fuzz-1');
        await dev2.connectTo('fuzz-3');
        await dev3.connectTo('fuzz-1');
        await dev3.connectTo('fuzz-2');
    });

    afterEach(async () => {
        await dev1.destroy();
        await dev2.destroy();
        await dev3.destroy();
        await tr1.close();
        await tr2.close();
        await tr3.close();
    });

    test(`fuzzes ${ITERATIONS} random operations across 3 peers and asserts convergence (seed: 0x${SEED.toString(16)})`, async () => {
        const prng = new SeededPRNG(SEED);
        const peers = [dev1, dev2, dev3];
        const filePool: string[] = [];

        for (let step = 0; step < ITERATIONS; step++) {
            const peer = peers[Math.floor(prng.next() * peers.length)];
            const actionRoll = prng.next();

            if (actionRoll < 0.50 || filePool.length === 0) {
                // Action 1: Create or overwrite file
                const path = `notes/note_${Math.floor(prng.next() * 15)}.md`;
                const content = `Step ${step}: updated by ${peer.deviceId} at ${Date.now()}`;
                await peer.writeFile(path, content);
                if (!filePool.includes(path)) filePool.push(path);
            } else if (actionRoll < 0.75) {
                // Action 2: Trigger partial sync
                const other = peers[Math.floor(prng.next() * peers.length)];
                if (other !== peer) {
                    await peer.syncWith(other.deviceId);
                }
            } else if (actionRoll < 0.90) {
                // Action 3: Rename an existing file
                const existing = filePool[Math.floor(prng.next() * filePool.length)];
                const newPath = `notes/renamed_${step}_${Math.floor(prng.next() * 10)}.md`;
                if (await peer.storage.exists(existing)) {
                    await peer.renameFile(existing, newPath);
                    const idx = filePool.indexOf(existing);
                    if (idx !== -1) filePool.splice(idx, 1);
                    filePool.push(newPath);
                }
            } else {
                // Action 4: Delete an existing file
                const existing = filePool[Math.floor(prng.next() * filePool.length)];
                if (await peer.storage.exists(existing)) {
                    await peer.deleteFile(existing);
                    const idx = filePool.indexOf(existing);
                    if (idx !== -1) filePool.splice(idx, 1);
                }
            }

            // Yield briefly to let in-flight microtasks advance
            if (step % 10 === 0) {
                await new Promise(r => setTimeout(r, 10));
            }
        }

        // Final Quiescence & Full Mesh Convergence Pass
        const converged = await waitForConvergence(peers, 4000);
        if (!converged) {
            console.error(`[STRESS FAILURE REPRODUCTION SEED] 0x${SEED.toString(16)}`);
            const t1 = await dev1.merkleManager.getMerkleTree();
            const t2 = await dev2.merkleManager.getMerkleTree();
            const t3 = await dev3.merkleManager.getMerkleTree();
            console.error('diff 1-2:', dev1.merkleManager.diffTrees(t1, t2));
            console.error('diff 1-3:', dev1.merkleManager.diffTrees(t1, t3));
        }
        expect(converged).toBe(true);

        const root1 = await dev1.getMerkleRoot();
        const root2 = await dev2.getMerkleRoot();
        const root3 = await dev3.getMerkleRoot();

        expect(root2).toBe(root1);
        expect(root3).toBe(root1);
    });
});
