import { collectLocalIpv4, preferLocalIpv4, parseHostInput, formatHostForUrl } from '../src/utils/net';

describe('collectLocalIpv4', () => {
    it('skips loopback and link-local addresses', () => {
        const addrs = collectLocalIpv4({
            Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
            Ethernet: [{ family: 'IPv4', internal: false, address: '169.254.10.1' }],
        });
        expect(addrs).toEqual([]);
    });

    it('prefers a Wi-Fi 192.168 address over Hyper-V / WSL adapters', () => {
        const addrs = collectLocalIpv4({
            'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.29.16.1' }],
            'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.42' }],
            'VirtualBox Host-Only': [{ family: 'IPv4', internal: false, address: '192.168.56.1' }],
        });
        expect(preferLocalIpv4(addrs)).toBe('192.168.1.42');
        expect(addrs.map(a => a.address)).toEqual(['192.168.1.42', '192.168.56.1', '172.29.16.1']);
    });

    it('accepts Node 18 numeric family 4', () => {
        const addrs = collectLocalIpv4({
            eth0: [{ family: 4, internal: false, address: '10.0.0.8' }],
        });
        expect(preferLocalIpv4(addrs)).toBe('10.0.0.8');
    });

    it('dedupes the same address on two names', () => {
        const addrs = collectLocalIpv4({
            Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.1.10' }],
            'Ethernet 2': [{ family: 'IPv4', internal: false, address: '192.168.1.10' }],
        });
        expect(addrs).toHaveLength(1);
    });
});

describe('parseHostInput', () => {
    it('accepts a bare address', () => {
        expect(parseHostInput(' 192.168.1.20 ')).toEqual({ host: '192.168.1.20', port: null, token: null });
    });

    it('accepts host:port', () => {
        expect(parseHostInput('192.168.1.20:41300')).toEqual({ host: '192.168.1.20', port: 41300, token: null });
        expect(parseHostInput('laptop.local:41300')).toEqual({ host: 'laptop.local', port: 41300, token: null });
    });

    it('accepts IPv6, bare or bracketed with a port', () => {
        expect(parseHostInput('fe80::1')).toEqual({ host: 'fe80::1', port: null, token: null });
        expect(parseHostInput('[fe80::1]:41235')).toEqual({ host: 'fe80::1', port: 41235, token: null });
    });

    it('takes the token from the host\'s "Copy IP and token" text', () => {
        expect(parseHostInput('192.168.1.20\nabc123\n')).toEqual({ host: '192.168.1.20', port: null, token: 'abc123' });
    });

    it('rejects things that are not addresses', () => {
        expect(parseHostInput('')).toBeNull();
        expect(parseHostInput('my laptop')).toBeNull();
        expect(parseHostInput('192.168.1.20:port')).toBeNull();
        expect(parseHostInput('192.168.1.20:70000')).toBeNull();
        expect(parseHostInput('host/../../x')).toEqual({ host: 'host', port: null, token: null });
    });
});

describe('formatHostForUrl', () => {
    it('brackets IPv6 literals only', () => {
        expect(formatHostForUrl('192.168.1.20')).toBe('192.168.1.20');
        expect(formatHostForUrl('fe80::1')).toBe('[fe80::1]');
        expect(formatHostForUrl('[fe80::1]')).toBe('[fe80::1]');
    });
});
