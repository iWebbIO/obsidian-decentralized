export const FACTORY_DEVICE_NAME = 'My New Device';

export const FRIENDLY_NAME_HINT = 'Name must be 1–64 characters.';

// 'phone' and 'desktop' are the plugin's OWN suggestions on fresh installs — two
// phones in one household would both be "Phone" with no warning, exactly the case
// the name-this-device prompt exists for.
const GENERIC = new Set(['', 'my new device', 'device', 'my device', 'new device', 'phone', 'desktop']);

export function isGenericDeviceName(name: string | undefined | null): boolean {
    return GENERIC.has((name ?? '').trim().toLowerCase());
}

/** Same 1–64-char rule as setFriendlyName. Returns a hint, or null when the name is acceptable. */
export function friendlyNameHint(name: string): string | null {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 64) return FRIENDLY_NAME_HINT;
    return null;
}

/** Prefer a real hostname on desktop; fall back to a short platform label. */
export function suggestedDeviceName(isMobile: boolean, hostname?: string | null): string {
    const host = (hostname ?? '').trim();
    if (!isMobile && host && host.length <= 64 && !/^localhost$/i.test(host)) return host;
    return isMobile ? 'Phone' : 'Desktop';
}
