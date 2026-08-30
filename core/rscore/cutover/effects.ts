/**
 * The engine's outputs, read back as the effects TypeScript publishes.
 *
 * One committed transaction produces two different kinds of observable: a
 * candidate effect the Entity forwards (a payment to the next hop, a resting
 * order), and a typed outcome the Entity reacts to (a revealed secret, an
 * order that stopped resting). TypeScript derives both from the transaction
 * result; the engine sends one flat list, so this rebuilds the split.
 *
 * Parity target: `shadowOutputRows` (../shadow-wire.ts) read backwards, and
 * `collectIncomingOkOutcome` (../../account/consensus/index.ts), which is the
 * TypeScript half being reproduced.
 */
import type { AccountOutput, AccountReplica, AccountSwapOfferSnapshot } from '../../types/account';
import type { SwapOfferEvent } from '../../account/tx/apply-types';
import { safeStringify } from '../../protocol/serialization';
import type { WaveOutput } from '../wave-decode';

export type CutoverAccountEffects = Readonly<{
  candidateEffects: AccountOutput[];
  revealedSecrets: Array<{ secret: string; hashlock: string }>;
  timedOutHashlocks: string[];
  swapOffersCreated: SwapOfferEvent[];
  swapCancelRequests: Array<{ offerId: string; accountId: string }>;
  swapOffersCancelled: Array<{ offerId: string; accountId: string }>;
}>;

const fail = (code: string, detail: Readonly<Record<string, unknown>> = {}): never => {
  throw new Error(`RSCORE_CUTOVER_EFFECT_${code}:${safeStringify(detail)}`);
};

const snapshot = (
  offer: Extract<WaveOutput, { kind: 'swapOfferUpsert' }>['offer'],
): AccountSwapOfferSnapshot => ({
  offerId: offer.offerId,
  leftEntity: offer.leftEntity,
  rightEntity: offer.rightEntity,
  giveTokenId: offer.giveTokenId,
  giveTokenDecimals: offer.giveTokenDecimals,
  giveAmount: BigInt(offer.giveAmount),
  wantTokenId: offer.wantTokenId,
  wantTokenDecimals: offer.wantTokenDecimals,
  wantAmount: BigInt(offer.wantAmount),
  maxFee: BigInt(offer.maxFee),
  minNetReceive: BigInt(offer.minNetReceive),
  priceTicks: BigInt(offer.priceTicks),
  ...(offer.timeInForce === null ? {} : { timeInForce: offer.timeInForce as 0 | 1 | 2 }),
  makerIsLeft: offer.makerIsRight === 0,
  createdHeight: offer.createdHeight,
  quantizedGive: BigInt(offer.quantizedGive),
  quantizedWant: BigInt(offer.quantizedWant),
  ...(offer.crossJurisdiction === null
    ? {}
    : { crossJurisdiction: offer.crossJurisdiction }),
  accountOutputVerified: true,
});

const offerCreated = (row: AccountSwapOfferSnapshot): SwapOfferEvent => ({
  offerId: row.offerId,
  makerIsLeft: row.makerIsLeft,
  fromEntity: row.leftEntity,
  toEntity: row.rightEntity,
  createdHeight: row.createdHeight,
  giveTokenId: row.giveTokenId,
  giveTokenDecimals: row.giveTokenDecimals,
  giveAmount: row.giveAmount,
  wantTokenId: row.wantTokenId,
  wantTokenDecimals: row.wantTokenDecimals,
  wantAmount: row.wantAmount,
  maxFee: row.maxFee,
  minNetReceive: row.minNetReceive,
  priceTicks: row.priceTicks,
  ...(row.timeInForce === undefined ? {} : { timeInForce: row.timeInForce }),
  ...(row.crossJurisdiction === undefined
    ? {}
    : { crossJurisdiction: row.crossJurisdiction }),
  accountOutputVerified: true,
});

/**
 * Project one committed window's outputs.
 *
 * `prior` is the Account as it stood before the window, which is what decides
 * whether an upsert created a resting order or moved one that already rested,
 * and which side of the account made an order that has now stopped resting.
 * The engine never says so, because its own state no longer holds either.
 */
export const cutoverAccountEffects = (
  prior: AccountReplica | null,
  ownerEntityId: string,
  accountId: string,
  outputs: readonly WaveOutput[],
): CutoverAccountEffects => {
  const candidateEffects: AccountOutput[] = [];
  const revealedSecrets: Array<{ secret: string; hashlock: string }> = [];
  const timedOutHashlocks: string[] = [];
  const swapOffersCreated: SwapOfferEvent[] = [];
  const swapCancelRequests: Array<{ offerId: string; accountId: string }> = [];
  const swapOffersCancelled: Array<{ offerId: string; accountId: string }> = [];
  const makers = new Map<string, boolean>();
  for (const [offerId, offer] of prior?.state.swapOffers ?? []) {
    makers.set(offerId, offer.makerIsLeft);
  }
  const resting = new Set(makers.keys());
  const sides = {
    left: prior?.state.leftEntity ?? '',
    right: prior?.state.rightEntity ?? '',
  };
  for (const output of outputs) {
    switch (output.kind) {
      case 'directPaymentForward':
        candidateEffects.push({
          kind: 'directPaymentForward',
          tokenId: output.tokenId,
          amount: BigInt(output.amount),
          route: [...output.route],
          ...(output.description === null ? {} : { description: output.description }),
          deliveryMode: output.deliveryMode,
          trustedGatewayEntityId: output.trustedGatewayEntityId,
        });
        break;
      case 'htlcSecret':
        revealedSecrets.push({ secret: output.secret, hashlock: output.hashlock });
        break;
      case 'htlcError':
        timedOutHashlocks.push(output.hashlock);
        break;
      case 'swapOfferUpsert': {
        const offer = snapshot(output.offer);
        candidateEffects.push({ kind: 'swapOfferUpsert', offer });
        // An order that was not resting before this window is one this window
        // created. A fill of an order that already rested only moves it.
        if (!resting.has(offer.offerId)) swapOffersCreated.push(offerCreated(offer));
        resting.add(offer.offerId);
        makers.set(offer.offerId, offer.makerIsLeft);
        break;
      }
      case 'swapOfferRemove': {
        candidateEffects.push({ kind: 'swapOfferRemove', offerId: output.offerId });
        const makerIsLeft = output.makerIsRight === 0;
        const priorMaker = makers.get(output.offerId);
        if (priorMaker !== undefined && priorMaker !== makerIsLeft) {
          return fail('OFFER_MAKER_MISMATCH', {
            account: accountId,
            offer: output.offerId,
            priorMakerIsLeft: priorMaker,
            outputMakerIsLeft: makerIsLeft,
          });
        }
        const maker = makerIsLeft ? sides.left : sides.right;
        if (maker.length === 0) {
          return fail('OFFER_MAKER_UNRESOLVED', { account: accountId, offer: output.offerId });
        }
        swapOffersCancelled.push({ offerId: output.offerId, accountId: maker });
        resting.delete(output.offerId);
        break;
      }
      case 'swapCancelRequest':
        candidateEffects.push({ kind: 'swapCancelRequest', offerId: output.offerId });
        swapCancelRequests.push({ offerId: output.offerId, accountId });
        break;
      case 'accountSettledFinalized': {
        const data = {
          entityId: ownerEntityId,
          accountId,
          tokenId: output.tokenId,
          jHeight: output.jHeight,
          collateral: output.collateral,
          ondelta: output.ondelta,
        };
        candidateEffects.push({
          kind: 'runtimeEvent',
          eventName: 'account_settled_finalized_bilateral',
          data,
        });
        candidateEffects.push({
          kind: 'debug',
          payload: {
            level: 'info',
            code: 'REB_STEP',
            step: 5,
            status: 'ok',
            event: 'account_settled_finalized_bilateral',
            ...data,
          },
        });
        break;
      }
      default:
        return fail('KIND_UNSUPPORTED', { account: accountId, output });
    }
  }
  return {
    candidateEffects,
    revealedSecrets,
    timedOutHashlocks,
    swapOffersCreated,
    swapCancelRequests,
    swapOffersCancelled,
  };
};
