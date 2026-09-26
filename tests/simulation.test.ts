jest.unmock('ws');

import { SimulatedNetwork, SimulatedTransport } from './simulation/SimulatedNetwork';
import { VirtualDevice } from './simulation/VirtualDevice';
import { LoopbackTransport } from './simulation/LoopbackTransport';

describe('Virtual Device Simulation Harness', () => {
    describe('In-Memory Simulated Network', () => {
        let network: SimulatedNetwork;
        let deviceA: VirtualDevice;
        let deviceB: VirtualDevice;
        let transportA: SimulatedTransport;
        let transportB: SimulatedTransport;

        beforeEach(async () => {
            network = new SimulatedNetwork(42); // Seeded PRNG
            deviceA = new VirtualDevice({ deviceId: 'device-a' });
            deviceB = new VirtualDevice({ deviceId: 'device-b' });

            transportA = new SimulatedTransport('device-a', network);
            transportB = new SimulatedTransport('device-b', network);

            deviceA.attachTransport(transportA);
            deviceB.attachTransport(transportB);

            await deviceA.connectTo('device-b');
            await deviceB.connectTo('device-a');
        });

        afterEach(async () => {
            await deviceA.destroy();
            await deviceB.destroy();
            await transportA.close();
            await transportB.close();
        });

        test('propagates file creation and syncs between devices', async () => {
            await deviceA.writeFile('notes/test.md', 'Hello from device A');

            // Wait a tick for microtask dispatch
            await new Promise(r => setTimeout(r, 50));

            expect(await deviceB.storage.exists('notes/test.md')).toBe(true);
            expect(await deviceB.storage.read('notes/test.md')).toBe('Hello from device A');

            // Merkle roots should now match
            const rootA = await deviceA.getMerkleRoot();
            const rootB = await deviceB.getMerkleRoot();
            expect(rootB).toBe(rootA);
        });

        test('propagates binary files', async () => {
            const bytes = new Uint8Array([10, 20, 30, 40, 50]).buffer;
            await deviceA.writeBinary('images/logo.png', bytes);

            await new Promise(r => setTimeout(r, 50));

            expect(await deviceB.storage.exists('images/logo.png')).toBe(true);
            const received = await deviceB.storage.readBinary('images/logo.png');
            expect(new Uint8Array(received)).toEqual(new Uint8Array([10, 20, 30, 40, 50]));
        });

        test('propagates file renames and deletions', async () => {
            await deviceA.writeFile('doc.txt', 'Content to move');
            await new Promise(r => setTimeout(r, 50));

            await deviceA.renameFile('doc.txt', 'renamed.txt');
            await new Promise(r => setTimeout(r, 50));

            expect(await deviceB.storage.exists('doc.txt')).toBe(false);
            expect(await deviceB.storage.exists('renamed.txt')).toBe(true);
            expect(await deviceB.storage.read('renamed.txt')).toBe('Content to move');

            await deviceA.deleteFile('renamed.txt');
            await new Promise(r => setTimeout(r, 50));
            expect(await deviceB.storage.exists('renamed.txt')).toBe(false);
        });
    });

    describe('Real Localhost WebSocket Loopback', () => {
        let device1: VirtualDevice;
        let device2: VirtualDevice;
        let transport1: LoopbackTransport;
        let transport2: LoopbackTransport;

        beforeEach(async () => {
            device1 = new VirtualDevice({ deviceId: 'node-1' });
            device2 = new VirtualDevice({ deviceId: 'node-2' });

            transport1 = new LoopbackTransport('node-1');
            transport2 = new LoopbackTransport('node-2');

            const port2 = await transport2.listen();
            await transport1.connect('node-2', port2);

            device1.attachTransport(transport1);
            device2.attachTransport(transport2);

            await device1.connectTo('node-2');
            await device2.connectTo('node-1');
        });

        afterEach(async () => {
            await Promise.all([device1.destroy(), device2.destroy()]);
            await Promise.all([transport1.close(), transport2.close()]);
        });

        test('syncs files over real TCP/WebSocket sockets', async () => {
            await device1.writeFile('socket-test.md', 'Real socket payload');

            // Wait briefly for real network socket transmission
            await new Promise(r => setTimeout(r, 100));

            expect(await device2.storage.exists('socket-test.md')).toBe(true);
            expect(await device2.storage.read('socket-test.md')).toBe('Real socket payload');

            const root1 = await device1.getMerkleRoot();
            const root2 = await device2.getMerkleRoot();
            expect(root2).toBe(root1);
        });
    });
});
