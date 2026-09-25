/** One IPv4 address on a named network adapter. */
export type LocalIpv4 = { name: string; address: string };

const VIRTUAL_IFACE = /vethernet|virtualbox|vmware|hyper-?v|wsl|docker|tailscale|zerotier|hamachi|vpn|loopback|bluetooth|teredo|isatap|pseudo/i;

type Ifaces = Record<string, Array<{ family: string | number; internal: boolean; address: string }> | undefined>;

function isIpv4(family: string | number): boolean {
    return family === 'IPv4' || family === 4;
}

function isLinkLocal(address: string): boolean {
    return address.startsWith('169.254.');
}

/** Higher is more likely to be the LAN address another device on Wi-Fi can reach. */
export function scoreLocalIpv4(entry: LocalIpv4): number {
    const parts = entry.address.split('.');
    const a = parseInt(parts[0], 10);
    const b = parseInt(parts[1], 10);
    const c = parseInt(parts[2], 10);
    let score = 0;
    if (a === 192 && b === 168) score += 50;
    else if (a === 10) score += 40;
    else if (a === 172 && b >= 16 && b <= 31) score += 20;
    else score += 5;

    // Host-only / ICS ranges that are almost never the shared Wi-Fi.
    if (a === 192 && b === 168 && (c === 56 || c === 137 || c === 99)) score -= 30;
    // Docker / WSL defaults sit in 172.16/12 and beat a real LAN if we only take the first NIC.
    if (a === 172 && (b === 17 || b === 18 || b === 19 || b === 23 || b === 24 || b === 29)) score -= 15;
    if (VIRTUAL_IFACE.test(entry.name)) score -= 40;
    return score;
}

/**
 * Non-internal IPv4 addresses, best LAN candidate first.
 * Node 18+ reports family as the number 4 rather than 'IPv4'.
 */
export function collectLocalIpv4(interfaces: Ifaces): LocalIpv4[] {
    const out: LocalIpv4[] = [];
    const seen = new Set<string>();
    for (const name of Object.keys(interfaces)) {
        const list = interfaces[name];
        if (!list) continue;
        for (const net of list) {
            if (!isIpv4(net.family) || net.internal || isLinkLocal(net.address)) continue;
            if (seen.has(net.address)) continue;
            seen.add(net.address);
            out.push({ name, address: net.address });
        }
    }
    return out.sort((a, b) => scoreLocalIpv4(b) - scoreLocalIpv4(a));
}

export function preferLocalIpv4(addrs: LocalIpv4[]): string | null {
    return addrs[0]?.address ?? null;
}

/** A host as it goes into a ws:// URL: IPv6 literals need brackets. */
export function formatHostForUrl(host: string): string {
    const bare = host.trim().replace(/^\[(.*)\]$/, '$1');
    return bare.includes(':') ? `[${bare}]` : bare;
}

export interface ParsedHostInput {
    host: string;
    port: number | null;
    /** Present when the pasted text carried the token too ("Copy IP and token"). */
    token: string | null;
}

/**
 * Read what someone typed or pasted into the "Host IP" box: `host`, `host:port`,
 * `[ipv6]:port`, a bare IPv6 address, or the host's "Copy IP and token" text
 * (address on the first line, token on the next). Null when there is no usable host.
 */
export function parseHostInput(raw: string): ParsedHostInput | null {
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    let address = lines[0].replace(/^wss?:\/\//i, '').replace(/\/.*$/, '');
    const token = lines.length > 1 ? lines[1] : null;
    let port: number | null = null;

    const bracketed = address.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (bracketed) {
        address = bracketed[1];
        if (bracketed[2]) port = Number(bracketed[2]);
    } else if ((address.match(/:/g) || []).length === 1) {
        const [host, portText] = address.split(':');
        if (!/^\d+$/.test(portText)) return null;
        address = host;
        port = Number(portText);
    }
    // Anything else with colons is a bare IPv6 address.

    if (!address || /\s/.test(address) || !/^[A-Za-z0-9.:%_-]+$/.test(address)) return null;
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
    return { host: address, port, token };
}
