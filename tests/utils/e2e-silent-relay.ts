import type { Page } from '@playwright/test';

declare global {
	  interface Window {
	    __relayErrorOnSubscribe?: boolean;
	    __syntheticRelayMarketSnapshots?: SyntheticRelayMarketSnapshot[];
	    __silentRelaySockets?: Array<{ sentMessages?: string[] }>;
	    __silentRelayStats?: Record<string, number>;
	    __silentRelayWebSocketInstalled?: boolean;
	  }
}

export type SyntheticRelayMarketLevel = {
  price: string;
  size: number;
  total?: number;
};

export type SyntheticRelayMarketSnapshot = {
  hubEntityId?: string;
  pairId?: string;
  bids?: SyntheticRelayMarketLevel[];
  asks?: SyntheticRelayMarketLevel[];
};

type SilentRelayInstallOptions = {
  currentPage?: boolean;
  errorOnSubscribe?: boolean;
  marketSnapshots?: SyntheticRelayMarketSnapshot[];
};

const SILENT_RELAY_WEBSOCKET_SCRIPT = `
      (() => {
	        window.__silentRelayStats = window.__silentRelayStats || {};
	        const bumpStat = (key) => {
	          window.__silentRelayStats[key] = Number(window.__silentRelayStats[key] || 0) + 1;
	        };
	        if (window.__silentRelayWebSocketInstalled) return;
	        window.__silentRelayWebSocketInstalled = true;
        const NativeWebSocket = window.WebSocket;
        const normalizeSyntheticLevels = (levels) => {
          let runningTotal = 0;
          return (Array.isArray(levels) ? levels : []).map((level) => {
            const size = Number(level && level.size || 0);
            runningTotal += Number.isFinite(size) && size > 0 ? size : 0;
            return {
              price: String(level && level.price || '0'),
              size,
              total: Number.isFinite(Number(level && level.total)) ? Number(level.total) : runningTotal,
            };
          }).filter((level) => Number.isFinite(level.size) && level.size > 0 && /^\\d+$/.test(level.price));
        };
        const pickSyntheticSnapshot = (hubEntityId, pairId) => {
          const snapshots = Array.isArray(window.__syntheticRelayMarketSnapshots)
            ? window.__syntheticRelayMarketSnapshots
            : [];
          const hub = String(hubEntityId || '').toLowerCase();
          const pair = String(pairId || '');
          return snapshots.find((snapshot) =>
            (!snapshot.hubEntityId || String(snapshot.hubEntityId).toLowerCase() === hub) &&
            (!snapshot.pairId || String(snapshot.pairId) === pair)
          ) || null;
        };
	        const dispatchNoMarketStatus = (socket, subscribeMessage) => {
	          if (!subscribeMessage) return;
	          if (socket.readyState !== NativeWebSocket.OPEN) return;
	          bumpStat('noMarketDispatches');
	          socket.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({
              type: 'market_status',
              inReplyTo: subscribeMessage.id || 'market_subscribe',
              status: 'no_market',
              data: {
                hubEntityIds: Array.isArray(subscribeMessage.hubEntityIds) ? subscribeMessage.hubEntityIds : [],
                pairs: Array.isArray(subscribeMessage.pairs) ? subscribeMessage.pairs : [],
                depth: Math.max(1, Math.min(100, Number(subscribeMessage.depth || 20) || 20)),
              },
            }),
          }));
        };
        const dispatchSyntheticSnapshots = (socket, subscribeMessage) => {
          if (!subscribeMessage || !Array.isArray(window.__syntheticRelayMarketSnapshots) || window.__syntheticRelayMarketSnapshots.length === 0) {
            dispatchNoMarketStatus(socket, subscribeMessage);
            return;
          }
          const hubs = Array.isArray(subscribeMessage.hubEntityIds) ? subscribeMessage.hubEntityIds : [];
          const pairs = Array.isArray(subscribeMessage.pairs) ? subscribeMessage.pairs : [];
          const depth = Math.max(1, Math.min(100, Number(subscribeMessage.depth || 20) || 20));
          if (socket.readyState !== NativeWebSocket.OPEN) return;
          let sentAny = false;
          for (const hubEntityId of hubs) {
            for (const pairId of pairs) {
              const snapshot = pickSyntheticSnapshot(hubEntityId, pairId);
	              if (!snapshot) continue;
	              const now = Date.now();
	              bumpStat('snapshotDispatches');
	              socket.dispatchEvent(new MessageEvent('message', {
                data: JSON.stringify({
                  type: 'market_snapshot',
                  id: 'synthetic_market_snapshot',
                  payload: {
                    format: 'exact-price-levels',
                    hubEntityId: String(hubEntityId || '').toLowerCase(),
                    pairId: String(pairId || ''),
                    depth,
                    displayDecimals: 4,
                    priceScale: '10000',
                    bucketWidthTicks: null,
                    bids: normalizeSyntheticLevels(snapshot.bids).slice(0, depth),
                    asks: normalizeSyntheticLevels(snapshot.asks).slice(0, depth),
                    spread: null,
                    spreadPercent: '-',
                    source: 'orderbookExt',
                    entityHeight: 1,
                    entityStateHash: null,
                    hubUpdatedAt: now,
                    updatedAt: now,
                  },
                }),
              }));
              sentAny = true;
            }
          }
          if (!sentAny) dispatchNoMarketStatus(socket, subscribeMessage);
        };
	        const hasConfiguredSyntheticSnapshots = () =>
	          Array.isArray(window.__syntheticRelayMarketSnapshots)
	          && window.__syntheticRelayMarketSnapshots.length > 0;
	        const stopSyntheticSnapshotStream = (socket) => {
	          if (!socket.syntheticMarketTimer) return;
	          clearInterval(socket.syntheticMarketTimer);
	          socket.syntheticMarketTimer = null;
	        };
	        const scheduleSyntheticSnapshots = (socket) => {
	          if (!socket.lastMarketSubscribe) return;
	          for (const delay of [0, 25, 100, 250]) {
	            setTimeout(() => {
	              if (socket.readyState !== NativeWebSocket.OPEN || !socket.lastMarketSubscribe) return;
	              socket.pendingMarketDispatch = false;
	              dispatchSyntheticSnapshots(socket, socket.lastMarketSubscribe);
	            }, delay);
	          }
	          stopSyntheticSnapshotStream(socket);
	          if (!hasConfiguredSyntheticSnapshots()) return;
	          socket.syntheticMarketTimer = setInterval(() => {
	            if (socket.readyState !== NativeWebSocket.OPEN || !socket.lastMarketSubscribe) {
	              stopSyntheticSnapshotStream(socket);
	              return;
	            }
	            dispatchSyntheticSnapshots(socket, socket.lastMarketSubscribe);
	          }, 750);
	        };
	        const queueOrDispatchSyntheticSnapshots = (socket, subscribeMessage) => {
	          socket.lastMarketSubscribe = subscribeMessage;
          if (socket.readyState !== NativeWebSocket.OPEN) {
            socket.pendingMarketDispatch = true;
            return;
          }
          scheduleSyntheticSnapshots(socket);
        };
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
		            lastMarketSubscribe: null,
		            pendingMarketDispatch: false,
		            syntheticMarketTimer: null,
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
	              if (type === 'message') bumpStat('messageEvents');
	              const handler = socket['on' + type];
	              if (typeof handler === 'function') {
	                if (type === 'message') bumpStat('onmessageCalls');
	                try {
	                  handler.call(socket, event);
	                } catch (error) {
	                  if (type === 'message') bumpStat('onmessageErrors');
	                  throw error;
	                }
	              }
	              for (const listener of listeners.get(type) || []) {
	                if (type === 'message') bumpStat('messageListenerCalls');
	                if (typeof listener === 'function') listener.call(socket, event);
	                else if (listener && typeof listener.handleEvent === 'function') listener.handleEvent(event);
	              }
	              return true;
	            },
            send(data) {
              const rawData = String(data || '');
              socket.sentMessages.push(rawData);
              if (window.__relayErrorOnSubscribe && rawData.includes('"market_subscribe"')) {
                const errorMessage = {
                  type: 'error',
                  inReplyTo: 'market_subscribe',
                  code: 'E_UNKNOWN_HUB',
                  error: 'Unknown market hub in test relay',
                };
                setTimeout(() => {
                  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(errorMessage) }));
                }, 0);
                return;
              }
              let message = null;
              try {
                message = JSON.parse(rawData);
              } catch {
                message = null;
              }
		              if (message && message.type === 'market_subscribe') {
		                bumpStat('marketSubscribes');
		                queueOrDispatchSyntheticSnapshots(socket, message);
		              } else if (message && message.type === 'market_snapshot_request') {
		                bumpStat('snapshotRequests');
		                queueOrDispatchSyntheticSnapshots(socket, socket.lastMarketSubscribe);
		              } else if (message && message.type === 'market_unsubscribe') {
		                stopSyntheticSnapshotStream(socket);
		              }
            },
	            close(code, reason) {
	              if (socket.readyState === NativeWebSocket.CLOSED) return;
	              stopSyntheticSnapshotStream(socket);
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
	            if (socket.pendingMarketDispatch && socket.lastMarketSubscribe) {
	              scheduleSyntheticSnapshots(socket);
	            }
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
  const snapshotsScript = `window.__syntheticRelayMarketSnapshots = ${JSON.stringify(options?.marketSnapshots || [])};`;
  await page.addInitScript({ content: `${modeScript}\n${snapshotsScript}\n${SILENT_RELAY_WEBSOCKET_SCRIPT}` });
  if (options?.currentPage) {
    await page.evaluate(({ shouldError, marketSnapshots, installScript }) => {
      window.__relayErrorOnSubscribe = shouldError;
      window.__syntheticRelayMarketSnapshots = marketSnapshots;
      // eslint-disable-next-line no-eval
      (0, eval)(installScript);
    }, {
      shouldError: Boolean(options.errorOnSubscribe),
      marketSnapshots: options?.marketSnapshots || [],
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
