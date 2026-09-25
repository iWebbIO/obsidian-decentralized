import type { PeerInfo } from '../types';

/** AES-256-GCM raw key as standard base64 (32 bytes → 44 chars with padding). */
export const PSK_PATTERN = /^[A-Za-z0-9+/]{40,}={0,2}$/;

export type ParsedPairing =
    | { kind: 'full'; deviceId: string; psk: string }
    | { kind: 'device-id'; deviceId: string }
    | { kind: 'empty' }
    | { kind: 'invalid'; reason: string };

/** Collapse whitespace and the decorative hyphen the old UI inserted into device IDs. */
export function normalizeDeviceId(input: string): string {
    const cleaned = input.trim().replace(/\s+/g, '');
    if (cleaned.startsWith('device-')) {
        return `device-${cleaned.substring(7).replace(/-/g, '')}`;
    }
    const justHex = cleaned.replace(/-/g, '');
    if (justHex.length === 8 && /^[0-9a-fA-F]{8}$/.test(justHex)) {
        return `device-${justHex.toLowerCase()}`;
    }
    return cleaned;
}

export function buildPairingPayload(deviceId: string, psk: string): string {
    return `${deviceId}|${psk}`;
}

/**
 * Parse what the user typed or pasted into Quick Pair.
 *
 * A full code is `deviceId|psk` — the only form that turns encryption on.
 * A bare device ID used to silently pair without a key; callers must treat
 * that as an error on the share/paste path.
 */
export function parsePairingInput(input: string): ParsedPairing {
    const trimmed = input.trim();
    if (!trimmed) return { kind: 'empty' };

    const pipe = trimmed.indexOf('|');
    if (pipe !== -1) {
        const deviceId = normalizeDeviceId(trimmed.slice(0, pipe));
        const psk = trimmed.slice(pipe + 1).trim();
        if (!deviceId) {
            return { kind: 'invalid', reason: 'That pairing code is missing a device ID. Copy it again from the other device.' };
        }
        if (!PSK_PATTERN.test(psk)) {
            return { kind: 'invalid', reason: 'That pairing code looks damaged. Copy it again from the other device.' };
        }
        return { kind: 'full', deviceId, psk };
    }

    const deviceId = normalizeDeviceId(trimmed);
    if (deviceId.startsWith('device-') || /^[A-Za-z0-9._-]{4,}$/.test(deviceId)) {
        return { kind: 'device-id', deviceId };
    }
    return {
        kind: 'invalid',
        reason: 'That does not look like a pairing code. Paste the code you copied from the other device.',
    };
}

/** Drop the ephemeral LAN pairing key before writing a peer to disk or gossip. */
export function persistablePeerInfo(peer: PeerInfo): PeerInfo {
    const { pairingKey: _pairingKey, ...rest } = peer;
    return rest;
}

const MAX_DEVICE_ID_LENGTH = 128;
const MAX_FRIENDLY_NAME_LENGTH = 64;

/**
 * Validate device info that arrived from another device (handshake, gossip, companion
 * pairing) and reduce it to what is safe to keep and show. Returns null when it is unusable.
 *
 * These fields go straight into settings (knownPeers) and the UI, and they were trusted as
 * sent: a missing peerInfo threw inside the handshake, and a name of any size or type was
 * persisted and rendered. The pairing key is always dropped — it is only meaningful on a
 * live LAN beacon and must never be stored or passed on.
 */
export function sanitizePeerInfo(raw: unknown): PeerInfo | null {
    if (!raw || typeof raw !== 'object') return null;
    const info = raw as Record<string, unknown>;
    const deviceId = typeof info.deviceId === 'string' ? info.deviceId.trim() : '';
    if (!deviceId || deviceId.length > MAX_DEVICE_ID_LENGTH) return null;

    const rawName = typeof info.friendlyName === 'string' ? info.friendlyName.trim() : '';
    const friendlyName = (rawName || deviceId).slice(0, MAX_FRIENDLY_NAME_LENGTH);
    const ip = typeof info.ip === 'string' && info.ip.length <= 64 ? info.ip : null;
    const port = typeof info.port === 'number' && Number.isInteger(info.port) && info.port > 0 && info.port < 65536
        ? info.port
        : undefined;
    const mode = info.mode === 'peerjs' || info.mode === 'direct-ip' ? info.mode : undefined;

    const clean: PeerInfo = { deviceId, friendlyName, ip };
    if (port !== undefined) clean.port = port;
    if (mode !== undefined) clean.mode = mode;
    return clean;
}
