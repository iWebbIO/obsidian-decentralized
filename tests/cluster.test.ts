/**
 * How the saved devices list grows. Gossip is the cheapest write vector into it: one
 * message can carry hundreds of entries, and every saved entry is dialled on every
 * reconnect interval and rewritten to data.json on every change — so the list must be
 * bounded, or a single connected peer turns both into unending churn.
 */
import { createDevice, teardown, waitFor, sleep } from './helpers/harness';

afterEach(teardown);

const A = 'device-aaaa0001';
const B = 'device-bbbb0002';

function fromA() {
    return { peer: A, open: true, send: jest.fn() } as any;
}

async function gossip(b: Awaited<ReturnType<typeof createDevice>>, peers: any[]) {
    await (b.plugin as any).processIncomingData({ type: 'cluster-gossip', peers }, fromA());
    // saveKnownPeers runs detached; give it a tick.
    await sleep(20);
}

describe('cluster gossip', () => {
    test('adds an unknown device below the ceiling and persists it', async () => {
        const b = await createDevice(B);
        const plugin: any = b.plugin;

        await gossip(b, [{ deviceId: 'device-cccc0003', friendlyName: 'Laptop' }]);

        expect(plugin.clusterPeers.get('device-cccc0003')).toMatchObject({ friendlyName: 'Laptop' });
        await waitFor(
            () => plugin.settings.knownPeers.some((p: any) => p.deviceId === 'device-cccc0003'),
            { what: 'the gossiped device to be saved' },
        );
    });

    test('ignores new entries once the saved list is full', async () => {
        const b = await createDevice(B);
        const plugin: any = b.plugin;
        // One per slot, up to the ceiling the production code enforces.
        for (let i = 0; i < 256; i++) {
            plugin.clusterPeers.set(`device-flood${i}`, { deviceId: `device-flood${i}`, friendlyName: `flood ${i}` });
        }

        await gossip(b, [{ deviceId: 'device-dddd0004', friendlyName: 'One too many' }]);
        await sleep(30);

        expect(plugin.clusterPeers.has('device-dddd0004')).toBe(false);
        // An existing entry is still refreshed, not dropped.
        expect(plugin.clusterPeers.has('device-flood255')).toBe(true);
    });

    test('never adds a blocked device', async () => {
        const b = await createDevice(B, { settings: { blockedPeers: ['device-eeee0005'] } });
        const plugin: any = b.plugin;

        await gossip(b, [{ deviceId: 'device-eeee0005', friendlyName: 'Removed' }]);
        await sleep(30);

        expect(plugin.clusterPeers.has('device-eeee0005')).toBe(false);
    });
});

describe('cluster control messages', () => {
    test('forget and kick only act on devices this vault knows', async () => {
        // The target ID is peer-supplied and grows blockedPeers; acting on arbitrary
        // strings let one malformed message bloat the list without doing anything useful.
        const b = await createDevice(B);
        const plugin: any = b.plugin;
        const before = plugin.settings.blockedPeers.length;

        await plugin.processIncomingData({ type: 'cluster-forget', targetDeviceId: 'device-unknown01' }, fromA());
        await plugin.processIncomingData({ type: 'cluster-kick', targetDeviceId: 'device-unknown02' }, fromA());
        await new Promise(r => setTimeout(r, 20));

        expect(plugin.settings.blockedPeers.length).toBe(before);
        expect(plugin.clusterPeers.has('device-unknown01')).toBe(false);
        expect(plugin.clusterPeers.has('device-unknown02')).toBe(false);
    });

    test('a known device can still be forgotten by instruction', async () => {
        const b = await createDevice(B);
        const plugin: any = b.plugin;
        plugin.clusterPeers.set('device-known0003', { deviceId: 'device-known0003', friendlyName: 'Known', ip: null });

        await plugin.processIncomingData({ type: 'cluster-forget', targetDeviceId: 'device-known0003' }, fromA());
        await waitFor(() => !plugin.clusterPeers.has('device-known0003'), { what: 'the device to be forgotten' });

        expect(plugin.settings.blockedPeers).toContain('device-known0003');
    });
});
