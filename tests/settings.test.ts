/**
 * Settings loading, run against the real plugin class.
 */
import { createDevice, teardown } from './helpers/harness';
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from '../src/types';

afterEach(teardown);

describe('loadSettings', () => {
    test('each instance gets its own copy of the defaults', async () => {
        // A shallow merge handed every instance DEFAULT_SETTINGS' own nested objects, so a
        // pairing key stored by one was visible to — and persisted by — the other.
        const a = await createDevice('device-aaaa0001');
        const b = await createDevice('device-bbbb0002');

        a.plugin.settings.peerKeys['device-cccc0003'] = 'key';
        a.plugin.settings.blockedPeers.push('device-dddd0004');
        a.plugin.settings.customPeerServerConfig.port = 1234;

        expect(b.plugin.settings.peerKeys).toEqual({});
        expect(b.plugin.settings.blockedPeers).toEqual([]);
        expect(DEFAULT_SETTINGS.peerKeys).toEqual({});
        expect(DEFAULT_SETTINGS.blockedPeers).toEqual([]);
        expect(DEFAULT_SETTINGS.customPeerServerConfig.port).toBe(9000);
    });

    test('a stored server config missing newer fields keeps their defaults', async () => {
        const a = await createDevice('device-aaaa0001', {
            settings: { customPeerServerConfig: { host: 'peers.example', port: 443 } as any },
        });

        expect(a.plugin.settings.customPeerServerConfig).toEqual({
            host: 'peers.example', port: 443, path: '/myapp', secure: false,
        });
    });
});

describe('settings migrations', () => {
    test('real-time keystroke sync is switched off for existing installs', async () => {
        // It used to default to on, so an install that never touched it has it saved as true.
        const device = await createDevice('device-aaaa0001', { settings: { enableRealtimeSync: true }, waitForOpen: false });
        expect(device.plugin.settings.enableRealtimeSync).toBe(false);
        expect(device.plugin.settings.settingsVersion).toBe(SETTINGS_VERSION);
        expect(((device.plugin as any)._data).enableRealtimeSync).toBe(false);
    });

    test('turning it back on afterwards sticks', async () => {
        const device = await createDevice('device-aaaa0001', { settings: { enableRealtimeSync: true, settingsVersion: SETTINGS_VERSION }, waitForOpen: false });
        expect(device.plugin.settings.enableRealtimeSync).toBe(true);
    });

    test('fresh installs start with it off', () => {
        expect(DEFAULT_SETTINGS.enableRealtimeSync).toBe(false);
    });
});
