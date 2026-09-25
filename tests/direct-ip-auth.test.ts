import {
    clientProof, hostProof, proofsMatch, deriveSessionKeys, sealFrame, openFrame, randomNonce, base64ToBytes, bytesToBase64,
} from '../src/utils/direct-ip-auth';

const TOKEN = 'shared-token';
const DEVICE = 'device-1';

describe('Offline Mode proofs', () => {
    test('both sides compute the same proof, and the two directions differ', async () => {
        const ns = randomNonce();
        const nc = randomNonce();
        const a = await clientProof(TOKEN, ns, nc, DEVICE);
        expect(proofsMatch(a, await clientProof(TOKEN, ns, nc, DEVICE))).toBe(true);
        expect(proofsMatch(a, await hostProof(TOKEN, ns, nc, DEVICE))).toBe(false);
    });

    test('a proof is bound to the token, both nonces and the device', async () => {
        const ns = randomNonce();
        const nc = randomNonce();
        const good = await clientProof(TOKEN, ns, nc, DEVICE);
        expect(proofsMatch(good, await clientProof('other-token', ns, nc, DEVICE))).toBe(false);
        expect(proofsMatch(good, await clientProof(TOKEN, randomNonce(), nc, DEVICE))).toBe(false);
        expect(proofsMatch(good, await clientProof(TOKEN, ns, randomNonce(), DEVICE))).toBe(false);
        expect(proofsMatch(good, await clientProof(TOKEN, ns, nc, 'device-2'))).toBe(false);
        expect(proofsMatch(undefined, good)).toBe(false);
    });
});

describe('Offline Mode frames', () => {
    test('round-trip with the matching key only', async () => {
        const ns = randomNonce();
        const nc = randomNonce();
        const client = await deriveSessionKeys(TOKEN, ns, nc, DEVICE);
        const host = await deriveSessionKeys(TOKEN, ns, nc, DEVICE);
        const frame = await sealFrame(client.clientToHost, new TextEncoder().encode('hello'));

        expect(new TextDecoder().decode(await openFrame(host.clientToHost, frame))).toBe('hello');
        await expect(openFrame(host.hostToClient, frame)).rejects.toBeDefined();
        const other = await deriveSessionKeys(TOKEN, randomNonce(), nc, DEVICE);
        await expect(openFrame(other.clientToHost, frame)).rejects.toBeDefined();
    });

    test('a tampered frame is rejected', async () => {
        const keys = await deriveSessionKeys(TOKEN, randomNonce(), randomNonce(), DEVICE);
        const frame = await sealFrame(keys.clientToHost, new Uint8Array([1, 2, 3]));
        frame[frame.length - 1] ^= 1;
        await expect(openFrame(keys.clientToHost, frame)).rejects.toBeDefined();
        await expect(openFrame(keys.clientToHost, new Uint8Array(5))).rejects.toThrow('too short');
    });

    test('base64 nonces are length-checked', () => {
        const nonce = randomNonce();
        expect(base64ToBytes(bytesToBase64(nonce), 16)).toEqual(nonce);
        expect(base64ToBytes(bytesToBase64(nonce), 12)).toBeNull();
        expect(base64ToBytes('%%%')).toBeNull();
        expect(base64ToBytes(42)).toBeNull();
    });
});
