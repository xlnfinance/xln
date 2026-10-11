import { swapMinimumError } from '../runtime/financial/orderbook-quote';
import { nativeAmountText } from './amount';
import { nativePaymentRequest, nativeInvoiceJurisdictionKeys } from './payment-request';
import { loadStackJurisdictions } from '../runtime/hosted';
import { nativeLimitAmounts } from './market';
import type { WalletView } from '../runtime/views';
import { formatMoney, parseAmount } from '../runtime/format';
import { getTokenMeta } from '../runtime/token-meta';
import {
  eligibleRoutes,
  isEntityId,
  quotePaymentRoutes,
  submitPayment,
  type PaymentRouteQuote,
} from '../runtime/financial/payments';
import { type BookView, quoteAtBestLevel } from '../runtime/financial/orderbook';
import { hubTakerFeeBps, jurisdictionRef, planSwap, readAccountState, submitSwapPlan, type SwapParty } from '../runtime/financial/swap';
import { getXLN } from '../runtime/xln-loader';
import { sendEntityTxs, waitFor } from '../runtime/tx';
import { receiveTestMoney } from '../runtime/financial/test-money';
import type { SwapCommandPlan } from '@xln/core/runtime/swap-cmd/swap-command-plan';

declare const __XLN_STACK_ORIGIN__: string;

type Ticket = {
  id: string;
  owner: string;
  expires: number;
  route?: PaymentRouteQuote;
  target?: string;
  token?: number;
  description?: string;
  plan?: SwapCommandPlan;
  orderAccountId?: string;
};
let ticket: Ticket | null = null;

export function invalidateNativeQuote(): void {
  // A quote authorizes one confirmation in the current unlocked session only.
  // Entity identity and deadline alone must not allow a pre-lock quote to spend
  // after the same signer reopens the wallet. The host calls this before I/O.
  ticket = null;
}

const text = (command: Record<string, unknown>, key: string): string => {
  const value = command[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Enter ${key}.`);
  return value.trim();
};
const amount = (command: Record<string, unknown>, token: number): bigint => {
  const value = parseAmount(
    nativeAmountText(text(command, 'amount'), command['decimalSeparator']),
    getTokenMeta(token).decimals,
  );
  if (value <= 0n) throw new Error('Amount must be greater than zero.');
  return value;
};
const money = (value: bigint, token: number): string =>
  `${formatMoney(value, getTokenMeta(token).decimals, getTokenMeta(token).decimals).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')} ${getTokenMeta(token).symbol}`;

async function payment(command: Record<string, unknown>, wallet: WalletView) {
  const target = text(command, 'recipient').toLowerCase();
  if (!isEntityId(target) || target === wallet.entityId) throw new Error('Choose another valid xln wallet.');
  const token = Number(command['token']);
  if (!wallet.totals.some(row => row.tokenId === token)) throw new Error('Choose an available asset.');
  const request = command['paymentRequest'] === undefined ? null : await readPaymentRequest(command, wallet);
  if (request && (request.recipient !== target || request.token !== token ||
    (request.amount && amount({ ...command, amount: request.amount }, token) !== amount(command, token))))
    throw new Error('Payment details changed. Scan the invoice again.');
  const routes = eligibleRoutes(
    await quotePaymentRoutes({
      sourceEntityId: wallet.entityId,
      targetEntityId: target,
      tokenId: token,
      amount: amount(command, token),
    }),
    'instant',
  );
  const selectedPath = command['routePath'];
  const route = selectedPath === undefined ? routes[0] : routes.find(option => option.path.join('/') === selectedPath);
  if (!route) throw new Error('No funded route is available. Check the recipient and available balance.');
  const description = request?.description || 'iPhone payment';
  ticket = { id: crypto.randomUUID(), owner: wallet.entityId, expires: Date.now() + 60_000, route, target, token, description };
  return {
    id: ticket.id,
    expiresAt: ticket.expires,
    title: 'Review payment',
    routePath: route.path.join('/'),
    routes: routes.map(option => ({
      id: option.path.join('/'),
      name: option.path.slice(1, -1).map(id => wallet.summaries.find(entry => entry.entityId === id)?.label ?? `${id.slice(0, 8)}…`).join(' → ') || 'Direct',
      fee: money(option.totalFee, token),
    })),
    give: money(route.senderAmount, token),
    receive: money(route.recipientAmount, token),
    fee: money(route.totalFee, token),
    destination: target,
    note: request?.description || 'Instant · amounts shown are maximum debit and fee',
    needsCapacity: false,
  };
}

async function readPaymentRequest(command: Record<string, unknown>, wallet: WalletView) {
  const identity = jurisdictionRef(wallet.frame);
  const keys = nativeInvoiceJurisdictionKeys(identity, await loadStackJurisdictions(__XLN_STACK_ORIGIN__));
  return nativePaymentRequest(command['paymentRequest'], {
    defaultToken: Number(command['token']),
    assets: wallet.totals.map(row => ({ id: row.tokenId, decimals: getTokenMeta(row.tokenId).decimals })),
    jurisdictions: [wallet.jurisdiction, identity, ...keys],
    decimalSeparator: command['decimalSeparator'],
  });
}

async function swap(command: Record<string, unknown>, wallet: WalletView, book: BookView) {
  const limit = command['type'] === 'quoteOrder'
    ? nativeLimitAmounts(command, book.baseTokenId, book.quoteTokenId,
      getTokenMeta(book.baseTokenId).decimals, getTokenMeta(book.quoteTokenId).decimals)
    : null;
  const giveToken = limit ? limit.giveToken : Number(command['token']);
  const wantToken = limit ? limit.wantToken : giveToken === 1 ? 2 : 1;
  if (![1, 2].includes(giveToken)) throw new Error('Choose USDC or WETH.');
  if (!wallet.frame || book.status !== 'live' || Date.now() - book.updatedAt > 30_000)
    throw new Error('Waiting for a fresh market price.');
  const give = limit ? limit.give : amount(command, giveToken);
  const quote = limit ? null : quoteAtBestLevel(
    book,
    giveToken,
    wantToken,
    give,
    getTokenMeta(book.baseTokenId).decimals,
    getTokenMeta(book.quoteTokenId).decimals,
  );
  if (!limit && !quote) throw new Error('There is no liquidity for this swap.');
  if (quote && give > quote.availableGive) throw new Error('This amount exceeds the best available price. Try a smaller swap.');
  const want = limit ? limit.want : quote!.want;
  const xln = await getXLN();
  const prepared = xln.prepareSwapOrder(giveToken, wantToken, give, want);
  if (!prepared) throw new Error('Amount is below the market minimum.');
  const minimumError = swapMinimumError(book, giveToken, prepared);
  if (minimumError) throw new Error(minimumError);
  const hub = wallet.accounts.find(row => row.isHub && !row.disputed);
  if (!hub) throw new Error('Connect a hub before swapping.');
  if (limit && command['hubId'] !== hub.counterpartyId) throw new Error('Market changed. Reopen the order book.');
  // React quotes from this same detached, committed Account snapshot. Reading
  // it again can queue a quote behind history repair and a waiting frame writer.
  let account: NonNullable<SwapParty['account']> = hub.doc.state;
  const capacityFor = (state: typeof account) => xln.planReceiveCapacity({
    account: state,
    ownerEntityId: wallet.entityId,
    counterpartyEntityId: hub.counterpartyId,
    tokenId: wantToken,
    requiredInboundAmount: prepared.effectiveWant,
    collateralPercent: command['testCredit'] === true ? 0 : 100,
    creditBufferBps: 0,
    allowOpenAccount: false,
  });
  let capacity = capacityFor(account);
  if (command['prepare'] === true && capacity.status === 'credit') {
    await sendEntityTxs(wallet.entityId, wallet.signerId, [...capacity.setupTxs]);
    await waitFor(async () => {
      const latest = await readAccountState(wallet.entityId, hub.counterpartyId);
      if (!latest) return false;
      const confirmed = capacityFor(latest);
      if (confirmed.status !== 'ready') return false;
      account = latest;
      capacity = confirmed;
      return true;
    }, 'incoming capacity confirmation');
    if (Date.now() - book.updatedAt > 30_000) throw new Error('Waiting for a fresh market price.');
  }
  const net = xln.deriveSwapNetAuthorization(prepared.effectiveWant, hubTakerFeeBps(hub.counterpartyId));
  const display = {
    title: 'Review swap',
    price: `${formatMoney(prepared.priceTicks, 4, 4)} ${getTokenMeta(book.quoteTokenId).symbol}`,
    give: money(prepared.effectiveGive, giveToken),
    receive: money(net.minNetReceive, wantToken),
    fee: money(net.maxFee, wantToken),
    destination: hub.label,
    note: 'Limit order · may close unfilled if price or liquidity changes',
    needsCapacity: capacity.status !== 'ready',
  };
  if (capacity.status !== 'ready') {
    ticket = null;
    return { ...display, id: '', expiresAt: 0 };
  }
  const plan = await planSwap({
    mode: 'same',
    frame: wallet.frame,
    source: {
      entityId: wallet.entityId,
      signerId: wallet.signerId,
      hubEntityId: hub.counterpartyId,
      jurisdiction: jurisdictionRef(wallet.frame),
      account,
    },
    giveTokenId: giveToken,
    giveTokenDecimals: getTokenMeta(giveToken).decimals,
    wantTokenId: wantToken,
    wantTokenDecimals: getTokenMeta(wantToken).decimals,
    giveAmount: prepared.effectiveGive,
    priceTicks: prepared.priceTicks,
    expectedWantAmount: prepared.effectiveWant,
    routeValue: `same:${hub.counterpartyId}`,
  });
  ticket = { id: crypto.randomUUID(), owner: wallet.entityId, expires: Date.now() + 60_000, plan, orderAccountId: hub.counterpartyId };
  return { ...display, id: ticket.id, expiresAt: ticket.expires };
}

export async function financialCommand(
  command: Record<string, unknown>,
  wallet: WalletView,
  book: BookView | null,
  onStage: (stage: string) => void,
): Promise<unknown> {
  switch (command['type']) {
    case 'readPaymentRequest':
      ticket = null;
      return readPaymentRequest(command, wallet);
    case 'faucet':
      if (command['testCredit'] !== true) throw new Error('Accept test credit before requesting test money.');
      await receiveTestMoney(wallet, onStage);
      return { message: '100 test USDC received' };
    case 'quotePayment':
      ticket = null;
      return payment(command, wallet);
    case 'quoteSwap':
    case 'quoteOrder':
      ticket = null;
      if (!book) throw new Error('Market is unavailable.');
      return swap(command, wallet, book);
    case 'confirm': {
      const chosen = ticket;
      ticket = null; // Consume before awaiting: repeated taps cannot send the same authorization twice.
      if (!chosen || chosen.id !== command['id'] || chosen.owner !== wallet.entityId || chosen.expires < Date.now())
        throw new Error('Quote expired. Review a fresh quote before continuing.');
      if (chosen.plan) {
        if (!chosen.orderAccountId) throw new Error('Order quote is incomplete.');
        await submitSwapPlan(chosen.plan);
        return { message: 'Order submitted. Execution is not confirmed yet.', offerId: chosen.plan.offerId, accountId: chosen.orderAccountId };
      }
      if (!chosen.route || !chosen.target || !chosen.token) throw new Error('Payment quote is incomplete.');
      await submitPayment({
        entityId: wallet.entityId,
        signerId: wallet.signerId,
        targetEntityId: chosen.target,
        tokenId: chosen.token,
        deliveryMode: 'instant',
        description: chosen.description ?? 'iPhone payment',
        route: chosen.route,
      });
      return { message: 'Payment submitted. Waiting for the confirmed receipt.' };
    }
    default:
      throw new Error('UNKNOWN_NATIVE_COMMAND');
  }
}
