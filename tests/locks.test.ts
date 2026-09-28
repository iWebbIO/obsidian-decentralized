/**
 * The two-device edit-lock protocol. Zero coverage existed before this suite: the
 * rules being pinned are the ones the sweep-11 audit found broken — a grant could be
 * overwritten by a second device, a request that timed out left the grantor deferring
 * syncs behind a lock nobody held, and neither map was purged when the link died.
 */
import { createDevice, connect, teardown, waitFor } from './helpers/harness';

afterEach(teardown);

const A = 'device-aaaa0001';
const B = 'device-bbbb0002';

describe('edit locks', () => {
    test('a lock is granted when the peer is not editing, and both sides record it', async () => {
        const a = await createDevice(A);
        const b = await createDevice(B);
        await connect(a, b);

        const granted = await b.plugin.requestLock('notes/joint.md');

        expect(granted).toBe(true);
        // The holder: expires when the grant said, aimed at its peer.
        const held = b.plugin.heldLocks.get('notes/joint.md');
        expect(held?.peerId).toBe(A);
        expect(held!.expiresAt).toBeGreaterThan(Date.now());
        // The grantor: the same path is now locked FROM the holder.
        expect(a.plugin.remoteLocks.get('notes/joint.md')?.peerId).toBe(B);
    });

    test('a request is denied while another device holds a live grant', async () => {
        const a = await createDevice(A);
        const b = await createDevice(B);
        await connect(a, b);
        // A (the grantor) already granted this path to a third device.
        a.plugin.remoteLocks.set('notes/joint.md', { peerId: 'device-cccc0003', expiresAt: Date.now() + 30_000 });
        const deny = jest.spyOn(a.plugin, 'sendData');

        // B asks through the real link: the message arrives on A's connection TO B.
        const conn = a.plugin.connections.get(B)!;
        await a.plugin.processIncomingData({ type: 'lock-request', path: 'notes/joint.md', requestId: 'r1' }, conn);

        // The grant must not be silently overwritten: both would then believe they
        // hold the note and stream edits into it.
        expect(deny).toHaveBeenCalledWith(B, expect.objectContaining({ type: 'lock-deny', requestId: 'r1' }));
        expect(a.plugin.remoteLocks.get('notes/joint.md')?.peerId).toBe('device-cccc0003');
        deny.mockRestore();
    });

    test('locks die with the link that carried them', async () => {
        const a = await createDevice(A);
        const b = await createDevice(B);
        await connect(a, b);
        b.plugin.heldLocks.set('notes/gone.md', { peerId: A, expiresAt: Date.now() + 30_000 });
        b.plugin.remoteLocks.set('notes/gone.md', { peerId: A, expiresAt: Date.now() + 30_000 });

        // A's link drops: B's close handler purges everything A was involved in.
        a.plugin.connections.get(B)?.close();
        await waitFor(
            () => !b.plugin.heldLocks.has('notes/gone.md') && !b.plugin.remoteLocks.has('notes/gone.md'),
            { what: 'both lock maps to be purged' },
        );
    });

    test('a dead direct-ip link is not "two devices"', async () => {
        // The client's mock connection stays in the map with open=false while its
        // socket is down — counting it kept every keystroke queueing lock requests
        // toward a dead link, each burning its full 5 s timeout.
        const b = await createDevice(B, { settings: { connectionMode: 'direct-ip' }, waitForOpen: false });
        b.plugin.connections.set('direct-ip-host', { open: false, peer: 'direct-ip-host' } as any);

        expect(b.plugin.isTwoDeviceMode()).toBe(false);
        expect(b.plugin.twoDevicePeerId).toBeNull();

        b.plugin.connections.set('direct-ip-host', { open: true, peer: 'direct-ip-host' } as any);
        expect(b.plugin.isTwoDeviceMode()).toBe(true);
    });

    test('the paired partner is the two-device peer, not whichever connection sorts first', async () => {
        const a = await createDevice(A);
        const b = await createDevice(B);
        await connect(a, b);
        // A gossiped a third device into B's list and B dialled it. Two open links are
        // not two-device mode by the live check — but a sync in progress latches the
        // mode, and the latch is exactly when editor traffic still flows. Insertion
        // order could then aim it at the wrong device.
        b.plugin.connections.set('device-zzzz0009', { open: true, peer: 'device-zzzz0009' } as any);
        b.plugin.settings.companionPeerId = A;
        (b.plugin as any).currentSyncIsTwoDeviceMode = true;

        expect(b.plugin.twoDevicePeerId).toBe(A);
    });
});
