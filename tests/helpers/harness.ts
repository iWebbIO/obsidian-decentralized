/**
 * Runs real ObsidianDecentralizedPlugin instances against each other: each "device" gets its
 * own in-memory vault (FakeVault) and PeerJS peer on a shared fake signalling network
 * (__mocks__/peerjs.ts). Encryption uses Node's real WebCrypto, so encrypted links are
 * exercised end to end rather than stubbed.
 *
 * Usage: `afterEach(teardown)`, then createDevice()/connect() inside a test.
 */
import * as obsidianModule from 'obsidian';
import * as peerjsModule from 'peerjs';
import type { ObsidianDecentralizedSettings } from '../../src/types';
import ObsidianDecentralizedPlugin from '../../src/main';
import { FakeApp, FakeVault } from './fake-vault';

// Import the mocks exactly as the plugin does. jest.requireMock() would load a SECOND copy of
// a root __mocks__ module, so Notice.messages, Platform and the fake network seen here would
// not be the ones the plugin uses — and assertions on them would pass vacuously.
const obsidianMock = obsidianModule as any;
const peerjsMock = peerjsModule as any;

/** The fake PeerJS module the plugin is using (FakePeer, FakeDataConnection, __network). */
export function peerjs(): any {
    return peerjsMock;
}

// --- Browser globals the plugin touches -------------------------------------------------

function installGlobals() {
    const listeners = new Map<string, Array<(ev: any) => void>>();
    const windowShim: any = {
        setTimeout: (fn: (...a: any[]) => void, ms?: number, ...args: any[]) => setTimeout(fn, ms, ...args),
        clearTimeout: (id: any) => clearTimeout(id),
        setInterval: (fn: (...a: any[]) => void, ms?: number, ...args: any[]) => setInterval(fn, ms, ...args),
        clearInterval: (id: any) => clearInterval(id),
        crypto: globalThis.crypto,
        btoa: (s: string) => btoa(s),
        atob: (s: string) => atob(s),
        addEventListener: (type: string, fn: (ev: any) => void) => {
            listeners.set(type, [...(listeners.get(type) ?? []), fn]);
        },
        removeEventListener: (type: string, fn: (ev: any) => void) => {
            listeners.set(type, (listeners.get(type) ?? []).filter(l => l !== fn));
        },
        /** Fire a window event such as 'online' (tests only). */
        dispatch: (type: string, ev: any = {}) => {
            for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
        },
        listenerCount: (type: string) => (listeners.get(type) ?? []).length,
    };
    Object.defineProperty(globalThis, 'window', { value: windowShim, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'document', {
        value: {
            body: new obsidianMock.FakeElement('body'),
            createElement: (tag: string) => new obsidianMock.FakeElement(tag),
        },
        writable: true,
        configurable: true,
    });
}

installGlobals();

// --- Devices ------------------------------------------------------------------------

export const MANIFEST = {
    id: 'obsidian-decentralized',
    name: 'Obsidian Decentralized',
    version: '0.0.0-test',
    minAppVersion: '1.8.3',
    description: 'test build',
    author: 'test',
    dir: '.obsidian/plugins/obsidian-decentralized',
};

/** Defaults that keep tests fast and deterministic. */
export const TEST_SETTINGS: Partial<ObsidianDecentralizedSettings> = {
    debounceDelay: 10,
    enableRealtimeSync: false,
};

export interface Device {
    id: string;
    plugin: ObsidianDecentralizedPlugin;
    app: FakeApp;
    vault: FakeVault;
}

const live = new Set<Device>();

export async function createDevice(
    id: string,
    opts: { name?: string; settings?: Partial<ObsidianDecentralizedSettings>; vault?: FakeVault; waitForOpen?: boolean } = {}
): Promise<Device> {
    // Nearby discovery is desktop-only and needs a UDP socket; the mobile code path swaps in
    // the no-op implementation.
    obsidianMock.Platform.isMobile = true;
    obsidianMock.Platform.isDesktop = false;

    const vault = opts.vault ?? new FakeVault();
    vault.ensureHiddenFolder(MANIFEST.dir);
    const app = new FakeApp(vault);
    const plugin = new ObsidianDecentralizedPlugin(app as any, { ...MANIFEST } as any);
    (plugin as any)._data = { ...TEST_SETTINGS, ...opts.settings, deviceId: id, friendlyName: opts.name ?? id };
    const device: Device = { id, plugin, app, vault };
    live.add(device);
    // Component.load() runs onload(); the mock returns its promise so setup can finish first.
    await (plugin as any).load();
    if (opts.waitForOpen !== false) {
        await waitFor(() => !!plugin.peer?.open, { what: `${id} to reach the signalling server` });
    }
    return device;
}

/** Share one pairing key between two devices, as a completed Quick Pair would. */
export async function pairKeys(a: Device, b: Device): Promise<string> {
    const psk = await a.plugin.generatePSK();
    a.plugin.settings.peerKeys[b.id] = psk;
    b.plugin.settings.peerKeys[a.id] = psk;
    a.plugin.invalidateCryptoKey();
    b.plugin.invalidateCryptoKey();
    return psk;
}

export function isLinked(from: Device, to: Device): boolean {
    return from.plugin.connections.get(to.id)?.open === true;
}

/** Dial b from a and wait for both handshakes. */
export async function connect(a: Device, b: Device, opts: { encrypted?: boolean } = {}) {
    if (opts.encrypted) await pairKeys(a, b);
    const plugin: any = a.plugin;
    if (typeof plugin.dialPeer === 'function') {
        plugin.dialPeer(b.id);
    } else {
        const conn = a.plugin.peer!.connect(b.id, { reliable: true });
        a.plugin.setupConnection(conn as any);
    }
    await waitFor(() => isLinked(a, b) && isLinked(b, a), { what: `${a.id} <-> ${b.id} handshake` });
}

// --- Waiting ------------------------------------------------------------------------

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    opts: { timeout?: number; interval?: number; what?: string } = {}
) {
    const deadline = Date.now() + (opts.timeout ?? 4000);
    for (;;) {
        if (await predicate()) return;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${opts.what ?? 'condition'}`);
        await sleep(opts.interval ?? 5);
    }
}

/** Resolve with the promise's value, or reject if it has not settled within `ms`. */
export function within<T>(promise: Promise<T>, ms: number, what = 'operation'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
        promise.then(
            value => { clearTimeout(timer); resolve(value); },
            err => { clearTimeout(timer); reject(err); },
        );
    });
}

// --- Inspection -----------------------------------------------------------------------

export function notices(): string[] {
    return obsidianMock.Notice.messages;
}

export function network(): {
    peers: Map<string, any>;
    created: any[];
    latencyMs: number;
} {
    return peerjsMock.__network;
}

// --- Teardown -------------------------------------------------------------------------

export async function teardown() {
    for (const device of live) {
        try {
            if ((device.plugin as any)._loaded) device.plugin.unload();
        } catch (e) {
            // Surface, but keep tearing the rest down.
            console.error(`teardown: unloading ${device.id} threw`, e);
        }
    }
    live.clear();
    peerjsMock.__network.reset();
    obsidianMock.Notice.clear();
    obsidianMock.Modal.openModals = [];
    await sleep(0);
}
