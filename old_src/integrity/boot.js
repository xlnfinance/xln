// Create basic HTML structure
document.documentElement.innerHTML = '<html><head><title>Integrity Browser</title></head><body></body></html>';
// SHA-256 implementation
function sha256(input) {
    const utf8Encode = (str) => {
        return new TextEncoder().encode(str);
    };

    const toHex = (bytes) => {
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    };

    const rightRotate = (value, amount) => {
        return (value >>> amount) | (value << (32 - amount));
    };

    const H = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);

    const K = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ]);

    let message = typeof input === 'string' ? utf8Encode(input) : new Uint8Array(input);
    const bitLength = message.length * 8;
    
    message = new Uint8Array([...message, 0x80]);
    const padding = new Uint8Array((64 - ((message.length + 8) % 64)) % 64);
    message = new Uint8Array([...message, ...padding, ...new Uint8Array(new BigUint64Array([BigInt(bitLength)]).buffer).reverse()]);

    for (let i = 0; i < message.length; i += 64) {
        const chunk = new Uint32Array(16);
        for (let j = 0; j < 16; j++) {
            chunk[j] = (message[i + j * 4] << 24) | (message[i + j * 4 + 1] << 16) | (message[i + j * 4 + 2] << 8) | message[i + j * 4 + 3];
        }

        const w = new Uint32Array(64);
        for (let t = 0; t < 16; t++) {
            w[t] = chunk[t];
        }
        for (let t = 16; t < 64; t++) {
            const s0 = rightRotate(w[t - 15], 7) ^ rightRotate(w[t - 15], 18) ^ (w[t - 15] >>> 3);
            const s1 = rightRotate(w[t - 2], 17) ^ rightRotate(w[t - 2], 19) ^ (w[t - 2] >>> 10);
            w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
        }

        let [a, b, c, d, e, f, g, h] = H;

        for (let t = 0; t < 64; t++) {
            const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + K[t] + w[t]) | 0;
            const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) | 0;

            h = g;
            g = f;
            f = e;
            e = (d + temp1) | 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) | 0;
        }

        H[0] = (H[0] + a) | 0;
        H[1] = (H[1] + b) | 0;
        H[2] = (H[2] + c) | 0;
        H[3] = (H[3] + d) | 0;
        H[4] = (H[4] + e) | 0;
        H[5] = (H[5] + f) | 0;
        H[6] = (H[6] + g) | 0;
        H[7] = (H[7] + h) | 0;
    }

    return toHex(new Uint8Array(H.buffer));
}

// Function to compute SHA-256 hash
async function subtlesha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
// Create UI elements
const topBar = document.createElement('div');
topBar.style.cssText = 'position:fixed;top:0;left:0;width:100%;background:#f0f0f0;padding:10px;box-shadow:0 2px 5px rgba(0,0,0,0.1);';

const urlInput = document.createElement('input');
urlInput.type = 'text';
urlInput.placeholder = 'Enter URL';
urlInput.style.cssText = 'width:80%;padding:5px;margin-right:10px;';

const goButton = document.createElement('button');
goButton.textContent = 'Go';
goButton.style.cssText = 'padding:5px 10px;';

const contentArea = document.createElement('textarea');
contentArea.style.cssText = 'width:100%;height:200px;margin-top:50px;';

const hashDisplay = document.createElement('div');
hashDisplay.style.cssText = 'margin-top:10px;';

const loadButton = document.createElement('button');
loadButton.textContent = 'Load';
loadButton.style.cssText = 'margin-top:10px;padding:5px 10px;';

// Append elements to the document
topBar.appendChild(urlInput);
topBar.appendChild(goButton);
document.body.appendChild(topBar);
document.body.appendChild(contentArea);
document.body.appendChild(hashDisplay);
document.body.appendChild(loadButton);

// Event listener for Go button and Enter key
async function fetchAndDisplayContent() {
    try {
        const response = await fetch(urlInput.value);
        const content = await response.text();
        contentArea.value = content;
        const hash = sha256(content);
        hashDisplay.textContent = `SHA-256: ${hash} / ${subtlesha256(content)}`;
    } catch (error) {
        console.error('Fetch error:', error);
        contentArea.value = 'Error fetching content';
    }
}

goButton.addEventListener('click', fetchAndDisplayContent);
urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') fetchAndDisplayContent();
});

// Event listener for Load button
loadButton.addEventListener('click', () => {
    const iframe = document.createElement('iframe');
    iframe.srcdoc = contentArea.value;
    iframe.sandbox = 'allow-scripts';
    iframe.style.cssText = 'width:100%;height:500px;border:none;';
    document.body.appendChild(iframe);
});

// Persistent storage mechanism (using localStorage)
const storageKey = 'integrityBrowserStorage';

// Function to save data
function saveData(url, key, value) {
    let storage = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (!storage[url]) storage[url] = {};
    storage[url][key] = value;
    localStorage.setItem(storageKey, JSON.stringify(storage));
}

// Function to load data
function loadData(url, key) {
    let storage = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (storage[url] && storage[url][key] !== undefined) {
        return storage[url][key];
    }
    return null;
}

// Expose storage API to iframe
window.addEventListener('message', (event) => {
    if (event.data.type === 'storage') {
        const url = urlInput.value;
        switch (event.data.action) {
            case 'set':
                saveData(url, event.data.key, event.data.value);
                break;
            case 'get':
                const value = loadData(url, event.data.key);
                event.source.postMessage({ type: 'storage', action: 'get', key: event.data.key, value }, '*');
                break;
        }
    }
});

// Initialize the UI
document.title = 'Integrity Browser';