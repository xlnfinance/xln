const { app, BrowserWindow, Menu, Notification, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {
	isAllowedExternalUrl,
	sanitizeNotificationPayload,
	setDesktopSecurityHeaders,
} = require('./security.cjs');

const ROOT = path.resolve(__dirname, '../..');
const WEB_DIR = path.resolve(process.env.XLN_DESKTOP_WEB_DIR || path.join(ROOT, 'frontend/build'));
const APP_NAME = 'XLN Wallet';

let mainWindow = null;
let staticServer = null;
let isQuitting = false;
let pendingDeepLink = null;

const mimeTypes = new Map([
	['.html', 'text/html; charset=utf-8'],
	['.js', 'text/javascript; charset=utf-8'],
	['.mjs', 'text/javascript; charset=utf-8'],
	['.css', 'text/css; charset=utf-8'],
	['.json', 'application/json; charset=utf-8'],
	['.png', 'image/png'],
	['.jpg', 'image/jpeg'],
	['.jpeg', 'image/jpeg'],
	['.svg', 'image/svg+xml; charset=utf-8'],
	['.ico', 'image/x-icon'],
	['.wasm', 'application/wasm'],
	['.mp3', 'audio/mpeg'],
	['.txt', 'text/plain; charset=utf-8'],
	['.md', 'text/markdown; charset=utf-8'],
]);

function resolveAsset(requestUrl) {
	let pathname = '/';
	try {
		pathname = new URL(requestUrl, 'http://127.0.0.1').pathname;
		pathname = decodeURIComponent(pathname);
	} catch {
		pathname = '/';
	}

	if (pathname === '/') pathname = '/app';
	let filePath = path.resolve(WEB_DIR, `.${pathname}`);
	if (!filePath.startsWith(`${WEB_DIR}${path.sep}`) && filePath !== WEB_DIR) return null;

	if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
		filePath = path.join(filePath, 'index.html');
	}
	if (!fs.existsSync(filePath)) {
		filePath = path.join(WEB_DIR, 'index.html');
	}
	return filePath;
}

function startStaticServer() {
	return new Promise((resolve, reject) => {
		if (!fs.existsSync(path.join(WEB_DIR, 'index.html'))) {
			reject(new Error(`Missing ${path.join(WEB_DIR, 'index.html')}. Run native build first.`));
			return;
		}

		staticServer = http.createServer((req, res) => {
			const filePath = resolveAsset(req.url || '/');
			if (!filePath) {
				res.writeHead(403);
				res.end('Forbidden');
				return;
			}

			fs.readFile(filePath, (err, data) => {
				if (err) {
					res.writeHead(404);
					res.end('Not found');
					return;
				}
				res.setHeader('Cache-Control', 'no-store');
				res.setHeader('Content-Type', mimeTypes.get(path.extname(filePath)) || 'application/octet-stream');
				setDesktopSecurityHeaders(res);
				res.end(data);
			});
		});

		staticServer.once('error', reject);
		staticServer.listen(0, '127.0.0.1', () => {
			const address = staticServer.address();
			if (!address || typeof address === 'string') {
				reject(new Error('Could not bind XLN desktop server'));
				return;
			}
			resolve(`http://127.0.0.1:${address.port}`);
		});
	});
}

function showMainWindow() {
	if (!mainWindow) return;
	if (mainWindow.isMinimized()) mainWindow.restore();
	mainWindow.show();
	mainWindow.focus();
}

function sendDeepLink(url) {
	if (!url) return;
	if (!mainWindow || mainWindow.webContents.isLoading()) {
		pendingDeepLink = url;
		return;
	}
	mainWindow.webContents.send('xln-desktop-deeplink', url);
	showMainWindow();
}

function installProtocolHandler() {
	const entry = process.argv[1] ? path.resolve(process.argv[1]) : __filename;
	if (process.defaultApp) {
		app.setAsDefaultProtocolClient('xln', process.execPath, [entry]);
		return;
	}
	app.setAsDefaultProtocolClient('xln');
}

function createMenu() {
	Menu.setApplicationMenu(Menu.buildFromTemplate([
		{
			label: APP_NAME,
			submenu: [
				{ label: 'Show XLN Wallet', click: showMainWindow },
				{ type: 'separator' },
				{ role: 'quit' },
			],
		},
		{
			label: 'Edit',
			submenu: [
				{ role: 'undo' },
				{ role: 'redo' },
				{ type: 'separator' },
				{ role: 'cut' },
				{ role: 'copy' },
				{ role: 'paste' },
				{ role: 'selectAll' },
			],
		},
		{
			label: 'View',
			submenu: [
				{ role: 'reload' },
				{ role: 'toggleDevTools' },
				{ type: 'separator' },
				{ role: 'resetZoom' },
				{ role: 'zoomIn' },
				{ role: 'zoomOut' },
			],
		},
	]));
}

function createWindow(baseUrl) {
	mainWindow = new BrowserWindow({
		width: 1280,
		height: 900,
		minWidth: 900,
		minHeight: 650,
		title: APP_NAME,
		backgroundColor: '#09090b',
		show: false,
		webPreferences: {
			preload: path.join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
		},
	});

	mainWindow.once('ready-to-show', () => showMainWindow());
	// The wallet UI is local. External navigation is a trust boundary: keep it
	// out of the privileged app window and only hand safe web/mail URLs to OS.
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith('xln://')) {
			sendDeepLink(url);
			return { action: 'deny' };
		}
		if (isAllowedExternalUrl(url)) shell.openExternal(url);
		return { action: 'deny' };
	});
	mainWindow.webContents.on('will-navigate', (event, url) => {
		if (url === baseUrl || url.startsWith(`${baseUrl}/`)) return;
		event.preventDefault();
		if (url.startsWith('xln://')) {
			sendDeepLink(url);
			return;
		}
		if (isAllowedExternalUrl(url)) shell.openExternal(url);
	});
	mainWindow.webContents.once('did-finish-load', () => {
		if (pendingDeepLink) {
			const url = pendingDeepLink;
			pendingDeepLink = null;
			sendDeepLink(url);
		}
		if (process.env.XLN_ELECTRON_SMOKE === '1') {
			setTimeout(() => app.quit(), 500);
		}
	});
	mainWindow.on('close', (event) => {
		if (isQuitting) return;
		event.preventDefault();
		mainWindow.hide();
	});

	mainWindow.loadURL(`${baseUrl}/app`);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on('second-instance', (_event, argv) => {
		sendDeepLink(argv.find(arg => arg.startsWith('xln://')) || null);
	});

	app.on('open-url', (event, url) => {
		event.preventDefault();
		sendDeepLink(url);
	});

	app.on('before-quit', () => {
		isQuitting = true;
	});

	app.whenReady().then(async () => {
		app.name = APP_NAME;
		app.on('web-contents-created', (_event, contents) => {
			contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
			contents.session.setPermissionCheckHandler(() => false);
		});
		installProtocolHandler();
		createMenu();
		const baseUrl = await startStaticServer();
		createWindow(baseUrl);
	});

	app.on('activate', () => {
		if (!mainWindow) return;
		showMainWindow();
	});

	app.on('will-quit', () => {
		if (staticServer) staticServer.close();
	});
}

ipcMain.handle('xln-desktop-notify-payment-wake', (_event, payload = {}) => {
	if (!Notification.isSupported()) return { ok: false, reason: 'notifications-unsupported' };
	const safePayload = sanitizeNotificationPayload(payload);
	const notification = new Notification({
		title: safePayload.title,
		body: safePayload.body,
		silent: false,
	});
	notification.on('click', showMainWindow);
	notification.show();
	return { ok: true };
});

ipcMain.handle('xln-desktop-version', () => ({
	electron: process.versions.electron,
	chrome: process.versions.chrome,
	node: process.versions.node,
}));
