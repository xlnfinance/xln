// === CRYPTOGRAPHIC UTILITIES ===
// Environment detection
const isBrowser = typeof window !== 'undefined';
// Simplified crypto compatibility
export const createHash = isBrowser ?
    (algorithm) => ({
        update: (data) => ({
            digest: (encoding) => {
                // Simple deterministic hash for browser demo
                let hash = 0;
                for (let i = 0; i < data.length; i++) {
                    const char = data.charCodeAt(i);
                    hash = ((hash << 5) - hash) + char;
                    hash = hash & hash; // Convert to 32bit integer
                }
                const hashStr = Math.abs(hash).toString(16).padStart(8, '0');
                return encoding === 'hex' ? hashStr : Buffer.from(hashStr);
            }
        })
    }) :
    require('crypto').createHash;
export const randomBytes = isBrowser ?
    (size) => {
        const array = new Uint8Array(size);
        crypto.getRandomValues(array);
        return array;
    } :
    require('crypto').randomBytes;
// Simplified Buffer polyfill for browser
const getBuffer = () => {
    if (isBrowser) {
        return {
            from: (data, encoding = 'utf8') => {
                if (typeof data === 'string') {
                    return new TextEncoder().encode(data);
                }
                return new Uint8Array(data);
            }
        };
    }
    return require('buffer').Buffer;
};
export const Buffer = getBuffer();
// Browser polyfill for Uint8Array.toString()
if (isBrowser) {
    Uint8Array.prototype.toString = function (encoding = 'utf8') {
        return new TextDecoder().decode(this);
    };
    window.Buffer = Buffer;
}
export const hash = (data) => createHash('sha256').update(data.toString()).digest();
// Use hex for Map/Set keys, Buffers for DB/RLP
export const ENC = 'hex';
