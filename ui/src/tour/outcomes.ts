import type { WalletView } from '../runtime/views';
import type { TourContext } from './steps';

export const core = (wallet: WalletView) => wallet.frame?.activeEntity?.core;
export const reserve = (wallet: WalletView) => core(wallet)?.reserves.get(1) ?? 0n;
export const collateral = (wallet: WalletView) =>
  wallet.accounts.reduce((sum, account) => sum + (account.tokens.find(token => token.tokenId === 1)?.delta.collateral ?? 0n), 0n);
export const external = (wallet: WalletView) => wallet.onchain.find(row => row.tokenId === 1)?.amount ?? 0n;

/** Only the signed Account subcontract tree proves funding; bank requests and portfolio previews do not. */
export const claims = (wallet: WalletView, kind: 'save' | 'loan') =>
  wallet.accounts.flatMap(account =>
    [...(account.doc.state.subcontracts ?? [])].flatMap(([id, claim]) =>
      'creditorIsLeft' in claim &&
      claim.tokenId === 1 &&
      claim.principal > 0n &&
      (kind === 'save'
        ? claim.kind !== 'loan' && claim.creditorIsLeft === account.isLeft
        : claim.kind === 'loan' && claim.creditorIsLeft !== account.isLeft)
        ? [{ id: `${account.counterpartyId}:${id}`, principal: claim.principal }]
        : [],
    ),
  );

export const committed = (ctx: TourContext): boolean =>
  Boolean(
    ctx.before &&
    !ctx.wallet.loading &&
    ctx.wallet.entityId === ctx.before.entityId &&
    core(ctx.wallet)?.entityId === ctx.wallet.entityId &&
    ctx.wallet.frameHeight > ctx.before.frameHeight,
  );
export const newClaim = (ctx: TourContext, kind: 'save' | 'loan'): boolean =>
  committed(ctx) && claims(ctx.wallet, kind).some(claim => !claims(ctx.before!, kind).some(old => old.id === claim.id));
export const closedClaim = (ctx: TourContext, kind: 'save' | 'loan'): boolean =>
  committed(ctx) &&
  claims(ctx.before!, kind).length > 0 &&
  claims(ctx.before!, kind).every(old => !claims(ctx.wallet, kind).some(claim => old.id === claim.id));
export const creditRaised = (ctx: TourContext): boolean =>
  committed(ctx) &&
  ctx.wallet.accounts.some(account => {
    const old = ctx.before!.accounts.find(row => row.counterpartyId === account.counterpartyId);
    return (
      old &&
      account.frameHeight > old.frameHeight &&
      account.tokens.some(
        token => token.derived.peerCreditLimit > (old.tokens.find(row => row.tokenId === token.tokenId)?.derived.peerCreditLimit ?? 0n),
      )
    );
  });
export const moved = (ctx: TourContext): boolean =>
  committed(ctx) &&
  collateral(ctx.wallet) >= collateral(ctx.before!) + 5_000_000n &&
  reserve(ctx.wallet) <= reserve(ctx.before!) - 5_000_000n;
export const withdrawn = (ctx: TourContext): boolean =>
  committed(ctx) && reserve(ctx.wallet) <= reserve(ctx.before!) - 5_000_000n && external(ctx.wallet) >= external(ctx.before!) + 5_000_000n;
export const crossClosed = (ctx: TourContext): boolean =>
  committed(ctx) &&
  [...(core(ctx.wallet)?.crossJurisdictionSwaps ?? [])].some(
    ([id, order]) =>
      order.source.entityId === ctx.wallet.entityId &&
      !core(ctx.before!)?.crossJurisdictionSwaps?.has(id) &&
      ['settled', 'cancelled'].includes(order.status),
  );
export const formed = (ctx: TourContext): boolean =>
  Boolean(
    ctx.before &&
    core(ctx.wallet)?.entityId === ctx.wallet.entityId &&
    core(ctx.wallet)?.height &&
    /^0x0{55}[0-9a-f]{9}$/i.test(ctx.wallet.entityId) &&
    !ctx.before.summaries.some(row => row.entityId === ctx.wallet.entityId),
  );

export const signedBalance = (wallet: WalletView, tokenId = 1) =>
  wallet.accounts.reduce((sum, account) => sum + (account.tokens.find(token => token.tokenId === tokenId)?.signed ?? 0n), 0n);

/** Terminal events come from durable Runtime receipts, after the Account debit/credit commits. */
export function invoicePaid(invoice: TourContext['invoice'], event: TourContext['incoming']): boolean {
  if (!invoice || !event) return false;
  return event.name === 'HtlcReceived' && event.runtimeId === invoice.runtimeId && event.height >= invoice.fromHeight &&
    event.data.entityId === invoice.entityId && event.data.toEntity === invoice.entityId &&
    event.data.tokenId === invoice.tokenId && event.data.amount === invoice.amount.toString() &&
    (event.data.description ?? '') === invoice.description &&
    (!invoice.hashlock || event.data.hashlock === invoice.hashlock) && (!invoice.id || event.data.invoiceId === invoice.id);
}

export const received = (ctx: TourContext): boolean =>
  committed(ctx) && ctx.invoice?.entityId === ctx.wallet.entityId && ctx.invoice.runtimeId === ctx.runtimeId &&
  ctx.invoice.tokenId === 1 && ctx.invoice.amount === 5_000_000n && invoicePaid(ctx.invoice, ctx.incoming) &&
  ctx.incoming!.height > ctx.before!.frameHeight && ctx.incoming!.height <= ctx.wallet.frameHeight &&
  signedBalance(ctx.wallet) >= signedBalance(ctx.before!) + 5_000_000n;

export function recovered(ctx: TourContext): boolean {
  const event = ctx.outgoing;
  // A durable terminal receipt identifies the committed payment by hashlock and
  // frame. Net balance can stay flat or rise when unrelated incoming credit commits.
  return Boolean(committed(ctx) && ctx.restored?.runtimeId === ctx.runtimeId &&
    ctx.restored.entityIds.includes(ctx.wallet.entityId) && ctx.wallet.frameHeight >= ctx.restored.height &&
    event?.runtimeId === ctx.runtimeId && event.name === 'HtlcFinalized' &&
    event.height > Math.max(ctx.restored.height, ctx.before!.frameHeight) && event.height <= ctx.wallet.frameHeight &&
    event.data.entityId === ctx.wallet.entityId && event.data.fromEntity === ctx.wallet.entityId &&
    event.data.tokenId === 1 && /^\d+$/.test(String(event.data.amount)) && BigInt(String(event.data.amount)) >= 1_000_000n &&
    typeof event.data.hashlock === 'string' && /^0x[0-9a-f]{64}$/i.test(event.data.hashlock));
}

export type TourBaseline = { step: string; wallet: WalletView };

/** Company formation compares against its original personal identity; other exercises follow the selected entity. */
export function tourBaseline(start: TourBaseline | null, step: string, wallet: WalletView): TourBaseline | null {
  if (!wallet.frame || wallet.loading || core(wallet)?.entityId !== wallet.entityId) return start;
  const changedEntity = start?.wallet.entityId !== wallet.entityId && step !== 'company';
  const funded = start && ['move', 'withdraw'].includes(step) && reserve(wallet) > reserve(start.wallet);
  return start?.step !== step || changedEntity || funded ? { step, wallet } : start;
}
