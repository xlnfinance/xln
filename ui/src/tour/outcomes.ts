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
