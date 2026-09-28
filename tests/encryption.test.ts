/**
 * Paired (keyed) links, end to end with real AES-GCM.
 *
 * Quick Pair always leaves both devices holding a key, and the receive path refuses any
 * plaintext from a peer it has a key for. Control replies — heartbeat pings, pongs, acks,
 * sync-acks — used to go out as raw conn.send() and were all refused: an idle paired link
 * closed on the 20 s heartbeat, every full sync aborted waiting for sync-acks, and every
 * small file ended in a timeout and a "Could not transfer" error.
 */
import { createDevice, connect, teardown, waitFor, within, notices, sleep, Device } from './helpers/harness';
import { FakeVault } from './helpers/fake-vault';

afterEach(teardown);

const A = 'device-aaaa0001';
const B = 'device-bbbb0002';

function lastHeard(device: Device): Map<string, number> {
    return (device.plugin as any).lastHeard;
}

function wire(device: Device): any[] {
    return ((device.plugin.peer as any)?.connections ?? []).flatMap((c: any) => c.sent);
}

function refusals(): string[] {
    return notices().filter(n => /unencrypted/i.test(n));
}

describe('paired links', () => {
    test('an idle link keeps hearing its peer, so the heartbeat does not drop it', async () => {
        const a = await createDevice(A);
        const b = await createDevice(B);
        await connect(a, b, { encrypted: true });

        // Both sides last heard from each other 15 s ago; one more silent round would close
        // the link at the 20 s mark.
        lastHeard(a).set(b.id, Date.now() - 15000);
        lastHeard(b).set(a.id, Date.now() - 15000);
        a.plugin.heartbeatTick();
        b.plugin.heartbeatTick();

        await waitFor(
            () => Date.now() - lastHeard(a).get(b.id)! < 5000 && Date.now() - lastHeard(b).get(a.id)! < 5000,
            { timeout: 2000, what: 'each side to hear the other' },
        );
        expect(refusals()).toEqual([]);
    });

    test('sync control messages are acknowledged', async () => {
        const a = await createDevice(A);
        const b = await createDevice(B);
        await connect(a, b, { encrypted: true });

        await within(a.plugin.sendSyncMessage(b.id, { type: 'test-noop' }), 3000, 'sendSyncMessage');
        expect(refusals()).toEqual([]);
    });

    test('a note sent over the link is acknowledged, not left to time out', async () => {
        const a = await createDevice(A);
        const b = await createDevice(B);
        await connect(a, b, { encrypted: true });

        await a.vault.create('note.md', 'only for my devices');
        await waitFor(() => b.vault.text('note.md') === 'only for my devices', { what: 'the note to arrive' });
        await waitFor(
            () => (a.plugin as any).pendingAcks.size === 0 && a.plugin.queueManager.getActiveTransfers() === 0,
            { timeout: 2000, what: 'the transfer to be acknowledged' },
        );
        expect(a.plugin.failedSyncs).toEqual([]);
        expect(refusals()).toEqual([]);
    });

    test('a full sync completes', async () => {
        const vaultA = new FakeVault();
        vaultA.seed('only-a.md', 'from a');
        vaultA.seed('shared/both.md', 'same');
        const vaultB = new FakeVault();
        vaultB.seed('only-b.md', 'from b');
        vaultB.seed('shared/both.md', 'same');
        // Two-device mode would start a Merkle reconciliation on connect; keep this test about
        // the full-sync protocol alone.
        const settings = { enableTwoDeviceOptimizations: false };
        const a = await createDevice(A, { vault: vaultA, settings });
        const b = await createDevice(B, { vault: vaultB, settings });
        await connect(a, b, { encrypted: true });

        await a.plugin.requestFullSyncFromPeer(b.id);
        await waitFor(() => !a.plugin.syncState.isSyncing && !b.plugin.syncState.isSyncing, {
            timeout: 8000,
            what: 'the full sync to finish',
        });

        // "Complete" means everything was sent; the last write can still be landing.
        await waitFor(() => a.vault.text('only-b.md') === 'from b' && b.vault.text('only-a.md') === 'from a', { what: 'both files to land' });
        expect(notices().filter(n => /Sync stopped/.test(n))).toEqual([]);
        expect(notices().some(n => /Sync complete/.test(n))).toBe(true);
        expect(refusals()).toEqual([]);
    });

    test('nothing crosses the link in plaintext', async () => {
        const a = await createDevice(A);
        const b = await createDevice(B);
        await connect(a, b, { encrypted: true });

        await a.vault.create('note.md', 'hello');
        await waitFor(() => b.vault.text('note.md') === 'hello', { what: 'the note to arrive' });
        a.plugin.heartbeatTick();
        b.plugin.heartbeatTick();
        await within(a.plugin.sendSyncMessage(b.id, { type: 'test-noop' }), 3000, 'sendSyncMessage');
        await sleep(50);

        const plaintext = [...wire(a), ...wire(b)].filter(m => m?.type !== 'encrypted-frame');
        expect(plaintext.map(m => m?.type)).toEqual([]);
    });

    test('the retired encryption toggle cannot switch a paired link to plaintext', async () => {
        // The Advanced toggle only affected the send side while the receiver kept refusing
        // plaintext from a keyed peer — turning it off broke every paired link.
        const a = await createDevice(A, { settings: { enableEncryption: false } });
        const b = await createDevice(B);
        await connect(a, b, { encrypted: true });

        await a.vault.create('note.md', 'still private');
        await waitFor(() => b.vault.text('note.md') === 'still private', { what: 'the note to arrive' });
        expect(refusals()).toEqual([]);
    });
});

describe('pairing-key hygiene', () => {
    test('the plaintext handshake never carries the active pairing key', async () => {
        // getMyPeerInfo embeds the ACTIVE PSK for the LAN beacon, and the handshake to
        // an unknown peer goes out in plaintext — sending that key in the clear handed
        // it to whoever dialed during a pairing window, with no user action on this side.
        const a = await createDevice(A);
        const plugin: any = a.plugin;
        await plugin.beginPairingWindow();
        expect(plugin.getActivePsk()).toBeTruthy();

        const sent: any[] = [];
        const conn = { peer: 'device-ffff0009', open: true, send: (m: any) => sent.push(m) };

        await (plugin as any).sendHandshake(conn);

        expect(sent).toHaveLength(1);
        expect(sent[0].peerInfo.pairingKey).toBeUndefined();
    });

    test('forgetting a device rotates the pairing key it still holds', async () => {
        // beginPairingWindow reused the same PSK forever, so a forgotten device still
        // holding it re-adopted the key on the next window and unblocked itself — the
        // device re-paired itself with no user action.
        const a = await createDevice(A);
        const plugin: any = a.plugin;
        const first = await plugin.beginPairingWindow();

        await plugin.forgetDevice('device-ffff0009');

        expect(plugin.getActivePsk()).toBeNull();
        const second = await plugin.beginPairingWindow();
        expect(second).toBeTruthy();
        expect(second).not.toBe(first);
    });

    test('a removed device cannot re-enrol through the active pairing key', async () => {
        const a = await createDevice(A, { settings: { blockedPeers: ['device-ffff0009'] } });
        const plugin: any = a.plugin;
        await plugin.beginPairingWindow();

        // Whatever it sends — a frame encrypted under the key it still holds, or
        // garbage — must not adopt, unblock or persist anything.
        await plugin.handleRawIncomingData(
            { type: 'encrypted-frame', data: new Uint8Array(13).buffer },
            { peer: 'device-ffff0009', open: true, send: jest.fn() });
        await sleep(20);

        expect(plugin.settings.peerKeys['device-ffff0009']).toBeUndefined();
        expect(plugin.settings.blockedPeers).toContain('device-ffff0009');
    });

    test('a failed settings save still drops the stale cached key', async () => {
        const a = await createDevice(A);
        const plugin: any = a.plugin;
        // Simulate a cached key for a peer whose stored PSK just changed.
        plugin.cryptoKeys.set('device-ffff0009', {} as any);
        plugin.settings.peerKeys['device-ffff0009'] = 'new-value';
        const failing = jest.spyOn(plugin, 'saveData').mockRejectedValueOnce(new Error('disk full'));

        await expect(plugin.saveSettings()).rejects.toThrow('disk full');

        expect(plugin.cryptoKeys.size).toBe(0);
        failing.mockRestore();
    });
});
