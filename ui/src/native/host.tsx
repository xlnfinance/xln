import './socket';
import { cancelNativeBrainvault, openNativeBrainvault } from './brainvault';
import { financialCommand, invalidateNativeQuote } from './commands';
import { nativeMarket } from './market';
import { walletEvidence } from './evidence';
import { walletHistory, walletOrders } from './history';
import { nativeBackup } from './backup';
import { startPaymentTerminal } from '../runtime/financial/receipts';
import { useReceipts } from '../runtime/financial/receipt-state';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Mnemonic } from 'ethers';
import { bootHostedVault, detectStack } from '../runtime/hosted';
import { lockEmbeddedRuntime, requireAdapter } from '../runtime/adapter';
import { useApp } from '../runtime/store';
import { useWallet, type WalletView } from '../runtime/views';
import { formatAmount, getTokenMeta } from '../runtime/format';
import { useOrderbook, type BookView } from '../runtime/financial/orderbook';

declare const __XLN_STACK_ORIGIN__: string;
declare global {
  interface Window {
    webkit?: { messageHandlers: { xln: { postMessage: (value: unknown) => void } } };
    xlnNative: { run: (command: Record<string, unknown>) => Promise<unknown> };
  }
}

export const publish = (value: unknown): void => {
  if (!window.webkit) throw new Error('NATIVE_MESSAGE_BRIDGE_MISSING');
  window.webkit.messageHandlers.xln.postMessage(value);
};

const networkLocation = new URL(__XLN_STACK_ORIGIN__);
let sessionOpen = false;
let wallet: WalletView | null = null;
let book: BookView | null = null;
export const currentWallet = (): WalletView => {
  if (!sessionOpen || !wallet?.frame || !requireAdapter().commandReady)
    throw new Error('Wallet is still synchronizing.');
  return wallet;
};
export const currentBook = (): BookView => {
  if (!book || book.status !== 'live') throw new Error('The order book is not available yet.');
  return book;
};

async function boot(entropy: unknown): Promise<void> {
  if (typeof entropy !== 'string' || !/^0x[0-9a-f]{32}$/.test(entropy)) throw new Error('INVALID_WALLET_ENTROPY');
  const stack = await detectStack(__XLN_STACK_ORIGIN__);
  if (!stack) throw new Error('The xln network is unavailable. Your wallet remains on this iPhone.');
  const seed = Mnemonic.fromEntropy(entropy).phrase;
  await bootHostedVault(seed, {
    chainScanTimeoutMs: 180_000,
    vaultId: 'ios-keychain',
    vaultName: 'My wallet',
    kind: 'mnemonic',
    selfLabel: 'My wallet',
    stack,
    onStep: message => publish({ kind: 'progress', message }),
  });
}

let executing = false;
window.xlnNative = {
  run: async command => {
    if (command['type'] === 'cancelBrainvault') return { cancelled: cancelNativeBrainvault() };
    if (executing) throw new Error('An operation is already in progress.');
    executing = true;
    try {
      switch (command['type']) {
        case 'brainvault':
          sessionOpen = false;
          invalidateNativeQuote();
          await lockEmbeddedRuntime();
          await openNativeBrainvault(command, publish);
          sessionOpen = true;
          return { ok: true };
        case 'boot':
          sessionOpen = false;
          invalidateNativeQuote();
          await lockEmbeddedRuntime();
          await boot(command['entropy']);
          sessionOpen = true;
          return { ok: true };
        case 'orders':
          return await walletOrders(currentWallet(), command['accountId'], command['cursor']);
        case 'history':
          return await walletHistory(currentWallet(), command['beforeHeight']);
        case 'evidence':
          return await walletEvidence(currentWallet());
        case 'backup':
        case 'verifyBackup':
          currentWallet();
          return await nativeBackup(command['type'] === 'backup', command['consent']);
        case 'lock':
          sessionOpen = false;
          invalidateNativeQuote();
          await lockEmbeddedRuntime();
          return { ok: true };
        default:
          return await financialCommand(command, currentWallet(), book, message =>
            publish({ kind: 'progress', message }),
          );
      }
    } finally {
      executing = false;
    }
  },
};

function RuntimeProjection() {
  useEffect(() => startPaymentTerminal(), []);
  const receipt = useReceipts(state => state.latest);
  useEffect(() => {
    if (receipt) publish({ kind: 'receipt', message: `Payment confirmed · frame ${receipt.height}` });
  }, [receipt]);
  const failure = useApp(state => state.toasts.find(toast => toast.kind === 'danger'));
  useEffect(() => {
    if (failure && sessionOpen) publish({ kind: 'error', message: failure.text });
  }, [failure]);
  const entityId = useApp(state => state.activeEntityId);
  const booting = useApp(state => state.booting);
  const ready = useApp(state => state.commandReady);
  const view = useWallet(entityId);
  const hub = view.accounts.find(account => account.isHub && !account.disputed);
  const market = useOrderbook({
    hubId: hub?.counterpartyId ?? '',
    tokenA: 1,
    tokenB: 2,
    ownEntityId: view.entityId,
    baseDecimals: 18,
    relayPageLocation: networkLocation,
    relayUrl: new URL('/relay', __XLN_STACK_ORIGIN__).href.replace(/^http/, 'ws'),
  });
  wallet = view;
  book = market;
  useEffect(() => {
    if (sessionOpen && view.frame && !booting && hub)
      publish(nativeMarket(market, hub.counterpartyId, hub.label));
  }, [market, hub, view.frame, booting]);
  useEffect(() => {
    if (!sessionOpen || !view.frame || booting) return;
    publish({
      kind: 'snapshot',
      name: view.name,
      entityId: view.entityId,
      height: view.frameHeight,
      network: view.jurisdiction,
      ready,
      error: view.error,
      tokens: view.totals
        .filter(token => token.active)
        .map(token => {
          const meta = getTokenMeta(token.tokenId);
          return {
            id: token.tokenId,
            symbol: meta.symbol,
            name: meta.name,
            amount: formatAmount(token.net, meta.decimals, meta.decimals),
            raw: token.net.toString(),
            available: formatAmount(token.sendCapacity, meta.decimals, meta.decimals),
          };
        }),
      accounts: view.accounts.map(account => ({
        id: account.counterpartyId,
        name: account.label,
        height: account.frameHeight,
        root: account.doc.currentFrame?.accountStateRoot ?? '',
        pending: Boolean(account.doc.pendingFrame),
        disputed: account.disputed,
      })),
      recipients: view.summaries
        .filter(entry => entry.entityId !== view.entityId && entry.jurisdiction?.name === view.jurisdiction)
        .map(entry => ({ id: entry.entityId, name: entry.label })),
    });
  }, [view, ready, booting]);
  return null;
}

window.addEventListener('error', event => publish({ kind: 'error', message: event.message }));
window.addEventListener('unhandledrejection', event => publish({ kind: 'error', message: String(event.reason) }));
const root = document.getElementById('runtime');
if (!root) throw new Error('NATIVE_RUNTIME_ROOT_MISSING');
createRoot(root).render(<RuntimeProjection />);
publish({
  kind: 'ready',
  secure: window.isSecureContext,
  crypto: Boolean(crypto.subtle),
  locks: Boolean(navigator.locks),
  workers: typeof Worker === 'function',
});
