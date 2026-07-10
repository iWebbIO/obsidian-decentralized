// Worker script for offloading heavy crypto operations to avoid blocking the main UI thread
export {};

self.addEventListener('message', async (event: MessageEvent) => {
    const { id, type, data, patches } = event.data;

    try {
        if (type === 'HASH') {
            const hashBuffer = await self.crypto.subtle.digest('SHA-256', data);
            const hashArray = new Uint8Array(hashBuffer);
            let hash = '';
            const hexTable = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
            for (let i = 0; i < hashArray.length; i++) {
                hash += hexTable[hashArray[i]];
            }
            self.postMessage({ id, success: true, result: hash });
        } 
        else if (type === 'DMP_MAKE') {
            // Placeholder for diff-match-patch offloading
            self.postMessage({ id, success: true, result: 'patch-result-placeholder' });
        }
        else {
            throw new Error(`Unknown worker task type: ${type}`);
        }
    } catch (e) {
        self.postMessage({ id, success: false, error: e instanceof Error ? e.message : String(e) });
    }
});
