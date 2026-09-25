import {
    buildPairingPayload,
    normalizeDeviceId,
    parsePairingInput,
    persistablePeerInfo,
    sanitizePeerInfo,
    PSK_PATTERN,
} from '../src/utils/pairing';

const SAMPLE_PSK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

describe('normalizeDeviceId', () => {
    it('strips the decorative hyphen the old UI inserted', () => {
        expect(normalizeDeviceId('device-abcd1234-ef567890')).toBe('device-abcd1234ef567890');
    });

    it('accepts a bare 8-char hex id', () => {
        expect(normalizeDeviceId('A1B2C3D4')).toBe('device-a1b2c3d4');
    });

    it('trims whitespace', () => {
        expect(normalizeDeviceId('  device-abcd1234  ')).toBe('device-abcd1234');
    });
});

describe('parsePairingInput', () => {
    it('parses a full deviceId|psk payload', () => {
        const raw = buildPairingPayload('device-abcd1234', SAMPLE_PSK);
        expect(parsePairingInput(raw)).toEqual({
            kind: 'full',
            deviceId: 'device-abcd1234',
            psk: SAMPLE_PSK,
        });
    });

    it('still parses a full payload when the device id was pretty-printed', () => {
        const raw = `device-abcd-1234|${SAMPLE_PSK}`;
        expect(parsePairingInput(`  ${raw}  `)).toEqual({
            kind: 'full',
            deviceId: 'device-abcd1234',
            psk: SAMPLE_PSK,
        });
    });

    it('flags a bare device id so the UI can refuse an unencrypted pair', () => {
        expect(parsePairingInput('device-abcd1234')).toEqual({
            kind: 'device-id',
            deviceId: 'device-abcd1234',
        });
    });

    it('rejects a payload whose key is not valid base64', () => {
        const parsed = parsePairingInput('device-abcd1234|short');
        expect(parsed.kind).toBe('invalid');
    });

    it('returns empty for blank input', () => {
        expect(parsePairingInput('   ')).toEqual({ kind: 'empty' });
    });

    it('accepts the generated PSK shape', () => {
        expect(PSK_PATTERN.test(SAMPLE_PSK)).toBe(true);
    });
});

describe('persistablePeerInfo', () => {
    it('strips the ephemeral pairing key', () => {
        expect(persistablePeerInfo({
            deviceId: 'device-1',
            friendlyName: 'Phone',
            ip: null,
            pairingKey: SAMPLE_PSK,
        })).toEqual({
            deviceId: 'device-1',
            friendlyName: 'Phone',
            ip: null,
        });
    });
});

describe('sanitizePeerInfo', () => {
    it('keeps the fields worth storing and drops the pairing key', () => {
        expect(sanitizePeerInfo({
            deviceId: 'device-1', friendlyName: '  Phone  ', ip: '192.168.1.5', port: 41235,
            mode: 'direct-ip', pairingKey: SAMPLE_PSK, extra: 'ignored',
        })).toEqual({ deviceId: 'device-1', friendlyName: 'Phone', ip: '192.168.1.5', port: 41235, mode: 'direct-ip' });
    });

    it('refuses info without a usable device ID', () => {
        // A handshake without peerInfo used to throw inside handleHandshake.
        expect(sanitizePeerInfo(undefined)).toBeNull();
        expect(sanitizePeerInfo({ friendlyName: 'x' })).toBeNull();
        expect(sanitizePeerInfo({ deviceId: '   ' })).toBeNull();
        expect(sanitizePeerInfo({ deviceId: 'x'.repeat(200) })).toBeNull();
        expect(sanitizePeerInfo({ deviceId: 42 })).toBeNull();
    });

    it('bounds and defaults the name instead of trusting it', () => {
        expect(sanitizePeerInfo({ deviceId: 'd', friendlyName: 'n'.repeat(500) })!.friendlyName).toHaveLength(64);
        expect(sanitizePeerInfo({ deviceId: 'd', friendlyName: { evil: true } })!.friendlyName).toBe('d');
        expect(sanitizePeerInfo({ deviceId: 'd' })!.friendlyName).toBe('d');
    });

    it('drops malformed optional fields', () => {
        const info = sanitizePeerInfo({ deviceId: 'd', ip: 7, port: 70000, mode: 'carrier-pigeon' })!;
        expect(info.ip).toBeNull();
        expect(info.port).toBeUndefined();
        expect(info.mode).toBeUndefined();
    });
});
