import type { Page } from '@playwright/test';

declare global {
  interface Window {
    __relayErrorOnSubscribe?: boolean;
    __silentRelaySockets?: Array<{ sentMessages?: string[] }>;
    __silentRelayWebSocketInstalled?: boolean;
  }
}

type SilentRelayInstallOptions = {
  currentPage?: boolean;
  errorOnSubscribe?: boolean;
};

const SILENT_RELAY_WEBSOCKET_SCRIPT = `
      (() => {
        if (window.__silentRelayWebSocketInstalled) return;
        window.__silentRelayWebSocketInstalled = true;
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = function SilentRelayWebSocket(url, protocols) {
          const rawUrl = String(url || '');
          const isRelay = /\\/relay(?:[?#].*)?$/.test(rawUrl);
          if (!isRelay) return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);

          const listeners = new Map();
          window.__silentRelaySockets = window.__silentRelaySockets || [];
          const socket = {
            url: rawUrl,
            protocol: '',
            extensions: '',
            bufferedAmount: 0,
            binaryType: 'blob',
            readyState: NativeWebSocket.CONNECTING,
            CONNECTING: NativeWebSocket.CONNECTING,
            OPEN: NativeWebSocket.OPEN,
            CLOSING: NativeWebSocket.CLOSING,
            CLOSED: NativeWebSocket.CLOSED,
            onopen: null,
            onmessage: null,
            onerror: null,
            onclose: null,
            sentMessages: [],
            addEventListener(type, listener) {
              if (!listener) return;
              const set = listeners.get(type) || new Set();
              set.add(listener);
              listeners.set(type, set);
            },
            removeEventListener(type, listener) {
              const set = listeners.get(type);
              if (set) set.delete(listener);
            },
            dispatchEvent(event) {
              const type = String(event && event.type || '');
              const handler = socket['on' + type];
              if (typeof handler === 'function') handler.call(socket, event);
              for (const listener of listeners.get(type) || []) {
                if (typeof listener === 'function') listener.call(socket, event);
                else if (listener && typeof listener.handleEvent === 'function') listener.handleEvent(event);
              }
              return true;
            },
            send(data) {
              socket.sentMessages.push(String(data || ''));
              if (window.__relayErrorOnSubscribe && String(data || '').includes('"market_subscribe"')) {
                const errorMessage = {
                  type: 'error',
                  inReplyTo: 'market_subscribe',
                  code: 'E_UNKNOWN_HUB',
                  error: 'Unknown market hub in test relay',
                };
                setTimeout(() => {
                  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(errorMessage) }));
                }, 0);
              }
            },
            close(code, reason) {
              if (socket.readyState === NativeWebSocket.CLOSED) return;
              socket.readyState = NativeWebSocket.CLOSING;
              setTimeout(() => {
                socket.readyState = NativeWebSocket.CLOSED;
                socket.dispatchEvent(new CloseEvent('close', { code: code || 1000, reason: String(reason || ''), wasClean: true }));
              }, 0);
            },
          };
          window.__silentRelaySockets.push(socket);
          setTimeout(() => {
            if (socket.readyState !== NativeWebSocket.CONNECTING) return;
            socket.readyState = NativeWebSocket.OPEN;
            socket.dispatchEvent(new Event('open'));
          }, 0);
          return socket;
        };
        Object.assign(window.WebSocket, {
          CONNECTING: NativeWebSocket.CONNECTING,
          OPEN: NativeWebSocket.OPEN,
          CLOSING: NativeWebSocket.CLOSING,
          CLOSED: NativeWebSocket.CLOSED,
        });
        window.WebSocket.prototype = NativeWebSocket.prototype;
      })();
`;

export async function installSilentRelayWebSocket(
  page: Page,
  options?: SilentRelayInstallOptions,
): Promise<void> {
  const modeScript = `window.__relayErrorOnSubscribe = ${options?.errorOnSubscribe ? 'true' : 'false'};`;
  await page.addInitScript({ content: `${modeScript}\n${SILENT_RELAY_WEBSOCKET_SCRIPT}` });
  if (options?.currentPage) {
    await page.evaluate(({ shouldError, installScript }) => {
      window.__relayErrorOnSubscribe = shouldError;
      // eslint-disable-next-line no-eval
      (0, eval)(installScript);
    }, {
      shouldError: Boolean(options.errorOnSubscribe),
      installScript: SILENT_RELAY_WEBSOCKET_SCRIPT,
    });
  }
}

export async function hasSilentRelayMarketSubscribe(
  page: Page,
  requiredFragments: readonly string[],
): Promise<boolean> {
  return page.evaluate((fragments) => {
    const sockets = window.__silentRelaySockets || [];
    return sockets.some((socket) => (socket.sentMessages || []).some((message) =>
      String(message || '').includes('"market_subscribe"') &&
      fragments.every((fragment) => String(message || '').includes(fragment)),
    ));
  }, Array.from(requiredFragments));
}
