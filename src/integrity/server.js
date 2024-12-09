const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3100;

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.url === '/boot.js') {
        fs.readFile(path.join(__dirname, 'boot.js'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading boot.js');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/javascript' });
            res.end(data);
        });
    } else if (req.url === '/') {
       const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Integrity Browser</title>
</head>
<body>
    <script src="./boot.js" 
            iintegrity="sha256-HASH_PLACEHOLDER" 
            crossorigin></script>
</body>
</html>`
res.writeHead(200, { 'Content-Type': 'text/html' });
res.end(html);

    } else if (req.url === '/app') {
        const html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Counter App</title>
            </head>
            <body>
                <h1>Counter: <span id="counter">0</span></h1>
                <button id="increment">Increment</button>
                <script>
                    let count = 0;
                    const counterElement = document.getElementById('counter');
                    const incrementButton = document.getElementById('increment');

                    function updateCounter() {
                        counterElement.textContent = count;
                    }

                    function increment() {
                        count++;
                        updateCounter();
                        saveCount();
                    }

                    function saveCount() {
                        window.parent.postMessage({ type: 'storage', action: 'set', key: 'count', value: count }, '*');
                    }

                    function loadCount() {
                        window.parent.postMessage({ type: 'storage', action: 'get', key: 'count' }, '*');
                    }

                    incrementButton.addEventListener('click', increment);

                    window.addEventListener('message', (event) => {
                        if (event.data.type === 'storage' && event.data.action === 'get' && event.data.key === 'count') {
                            count = event.data.value || 0;
                            updateCounter();
                        }
                    });

                    loadCount();
                </script>
            </body>
            </html>
        `;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
});