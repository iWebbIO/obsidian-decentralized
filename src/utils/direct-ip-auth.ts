/**
 * Offline Mode authentication and encryption.
 *
 * The join token used to travel in the WebSocket URL and every frame after it went over the
 * LAN in plaintext: anyone on the same Wi-Fi could read the notes and replay the token. Now
 * the token never leaves either device:
 *
 *   host   → client  od-auth-challenge { nonce: Ns }
 *   client → host    od-auth-proof     { nonce: Nc, proof: HMAC(token, "client" | Ns | Nc | deviceId) }
 *   host   → client  od-auth-ok        { proof: HMAC(token, "host" | Ns | Nc | deviceId) }
 *
 * Both proofs are checked, so the joining device also knows it reached the real host. Each
 * direction then gets its own AES-256-GCM key, derived with HKDF from the token and both
 * nonces, and every later frame is [12-byte IV][ciphertext].
 */

export const DIRECT_IP_AUTH_VERSION = 1;
export const AUTH_CHALLENGE = 'od-auth-challenge';
export const AUTH_PROOF = 'od-auth-proof';
export const AUTH_OK = 'od-auth-ok';

const encoder = new TextEncoder();

function subtle(): SubtleCrypto {
    return globalThis.crypto.subtle;
}

export function randomNonce(): Uint8Array {
    return globalThis.crypto.getRandomValues(new Uint8Array(16));
}

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

/** Decode base64, or null when `value` is not a base64 string of `expectedLength` bytes. */
export function base64ToBytes(value: unknown, expectedLength?: number): Uint8Array | null {
    if (typeof value !== 'string' || value.length > 1024) return null;
    let binary: string;
    try {
        binary = atob(value);
    } catch {
        return null;
    }
    if (expectedLength !== undefined && binary.length !== expectedLength) return null;
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

function concat(...parts: Array<Uint8Array | string>): Uint8Array {
    const chunks = parts.map(p => (typeof p === 'string' ? encoder.encode(p) : p));
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength + 4, 0));
    const view = new DataView(out.buffer);
    let offset = 0;
    for (const chunk of chunks) {
        // Length-prefixed, so no two different part lists produce the same input.
        view.setUint32(offset, chunk.byteLength);
        out.set(chunk, offset + 4);
        offset += chunk.byteLength + 4;
    }
    return out;
}

async function hmac(token: string, ...parts: Array<Uint8Array | string>): Promise<string> {
    const key = await subtle().importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await subtle().sign('HMAC', key, concat(...parts));
    return bytesToBase64(new Uint8Array(mac));
}

/** The joining device's proof that it holds the token. */
export function clientProof(token: string, serverNonce: Uint8Array, clientNonce: Uint8Array, deviceId: string): Promise<string> {
    return hmac(token, 'od-direct-ip client', serverNonce, clientNonce, deviceId);
}

/** The host's proof that it holds the token, bound to this exchange. */
export function hostProof(token: string, serverNonce: Uint8Array, clientNonce: Uint8Array, deviceId: string): Promise<string> {
    return hmac(token, 'od-direct-ip host', serverNonce, clientNonce, deviceId);
}

/** Compare two proofs without leaking where they first differ. */
export function proofsMatch(a: unknown, b: string): boolean {
    if (typeof a !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export interface SessionKeys {
    /** Encrypts frames from the joining device to the host. */
    clientToHost: CryptoKey;
    /** Encrypts frames from the host to the joining device. */
    hostToClient: CryptoKey;
}

export async function deriveSessionKeys(token: string, serverNonce: Uint8Array, clientNonce: Uint8Array, deviceId: string): Promise<SessionKeys> {
    const base = await subtle().importKey('raw', encoder.encode(token), 'HKDF', false, ['deriveKey']);
    const salt = concat(serverNonce, clientNonce);
    const derive = (direction: string) => subtle().deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt, info: concat('od-direct-ip v1', direction, deviceId) },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
    const [clientToHost, hostToClient] = await Promise.all([derive('client-to-host'), derive('host-to-client')]);
    return { clientToHost, hostToClient };
}

/** Encrypt one frame: [12-byte IV][AES-GCM ciphertext]. */
export async function sealFrame(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, plaintext));
    const frame = new Uint8Array(12 + ciphertext.byteLength);
    frame.set(iv, 0);
    frame.set(ciphertext, 12);
    return frame;
}

/** Decrypt one frame. Throws if it was not produced with `key` or was tampered with. */
export async function openFrame(key: CryptoKey, frame: Uint8Array): Promise<ArrayBuffer> {
    if (frame.byteLength < 13) throw new Error('Offline Mode frame too short');
    return subtle().decrypt({ name: 'AES-GCM', iv: frame.subarray(0, 12) }, key, frame.subarray(12));
}
