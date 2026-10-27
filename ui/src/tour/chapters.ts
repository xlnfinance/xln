import { WALLET_LESSONS } from '@xln/frontend/lib/tutorial/curriculum';
import type { TourContext, TourStep } from './steps';
import {
  claims,
  closedClaim,
  collateral,
  committed,
  core,
  creditRaised,
  crossClosed,
  formed,
  moved,
  newClaim,
  reserve,
  received,
  recovered,
  withdrawn,
} from './outcomes';

const accountRoute = (ctx: TourContext) => (ctx.wallet.accounts[0] ? `/accounts/${ctx.wallet.accounts[0].counterpartyId}` : '/');
type Exercise = {
  path: string | ((ctx: TourContext) => string);
  target: string;
  instruction?: string;
  done?: (ctx: TourContext) => boolean;
  skipReason?: (ctx: TourContext) => string;
};
const noReserve = (ctx: TourContext) =>
  reserve(ctx.wallet) < 5_000_000n
    ? 'Requires 5 USDC in Depository reserve and test gas. Account faucet credit is not reserve money; use Assets faucets first.'
    : '';
const noLoan = (ctx: TourContext) =>
  claims(ctx.wallet, 'loan').length === 0
    ? 'No funded loan exists. A bank must publish terms, approve your facility and fund the loan before repayment is possible.'
    : '';

/** One exercise table. Financial completion reads committed state, never screen presence or submission toasts. */
const exercises: Record<string, Exercise> = {
  jurisdiction: { path: '/', target: 'jurisdiction-stack' },
  cross: {
    path: '/swap',
    target: 'swap-cross-mode',
    done: crossClosed,
    instruction:
      'Choose Across networks. Submit a small order with an explicit minimum. Clear delivery or cancel the unmatched remainder; wait for committed settled or cancelled state.',
    skipReason: ctx =>
      new Set(ctx.wallet.summaries.map(row => row.jurisdiction?.name).filter(Boolean)).size < 2
        ? 'This stack advertises fewer than two jurisdictions. Cross-network delivery requires two identities, accepted hub accounts and a matching venue.'
        : '',
  },
  receive: {
    path: '/receive',
    target: 'receive-amount',
    instruction:
      'Request 5 USDC, copy the payment link and pay it from a second test wallet. Wait here for the committed incoming balance increase.',
    done: received,
  },
  hubs: {
    path: '/',
    target: 'home-open-account',
    done: ctx =>
      committed(ctx) &&
      ctx.wallet.accounts.some(
        account =>
          account.isHub && account.frameHeight > 0 && !ctx.before!.accounts.some(old => old.counterpartyId === account.counterpartyId),
      ),
    skipReason: ctx =>
      !ctx.wallet.summaries.some(
        row =>
          row.isHub &&
          row.jurisdiction?.name === ctx.wallet.jurisdiction &&
          !ctx.wallet.accounts.some(account => account.counterpartyId === row.entityId),
      )
        ? 'No additional hub in this jurisdiction is advertised by this stack. A second hub must be online to accept the account.'
        : '',
  },
  limits: {
    path: accountRoute,
    target: 'account-extend-credit',
    done: creditRaised,
    instruction:
      'Open Extend credit. Raise the USDC limit by 1 above its current value. Wait for the hub to countersign; this changes exposure, not your balance.',
  },
  move: {
    path: '/move',
    target: 'move-amount',
    done: moved,
    skipReason: noReserve,
    instruction:
      'Get gas and reserve USDC from Assets if needed. Choose Reserve → Account, enter 5 USDC, then review and Move now. Wait for reserve to fall and confirmed collateral to rise by 5.',
  },
  withdraw: {
    path: '/move?from=reserve&to=external',
    target: 'move-to-external',
    done: withdrawn,
    skipReason: noReserve,
    instruction:
      'Choose Reserve → Wallet. Enter your own signer address and 5 USDC, review and Move now. Wait for the reserve debit AND the external wallet credit.',
  },
  lending: {
    path: '/lend',
    target: 'lend-amount',
    done: ctx => newClaim(ctx, 'save'),
    instruction:
      'Choose Lend and On demand. Save 5 USDC and accept any explicitly disclosed risk change. Wait for a signed savings covenant; a submitted offer is not a position.',
    skipReason: ctx => (ctx.dom.has('lending-bank-terms') ? `Bank unavailable: ${ctx.dom.text('lending-bank-terms')}` : ''),
  },
  borrow: {
    path: '/lend',
    target: 'lend-side-borrow',
    done: ctx => newClaim(ctx, 'loan'),
    instruction:
      'Choose Borrow, enter 2 USDC, select 1 day and review the maximum rate. Request the loan; wait for a signed loan covenant and principal delivery. The bank must approve a facility first.',
    skipReason: ctx =>
      ctx.dom.has('lending-no-facility')
        ? 'This bank has approved no borrowing facility for this wallet and term. A request alone cannot fund a loan; ask the test bank officer to approve it.'
        : '',
  },
  repay: {
    path: '/lend',
    target: 'lending-repay',
    done: ctx => closedClaim(ctx, 'loan'),
    skipReason: noLoan,
    instruction:
      'Repay the full displayed loan amount. Wait for the signed loan covenant to disappear; queued repayment and a pending request do not close debt.',
  },
  protection: {
    path: '/sovereignty',
    target: 'watchtower-url',
    instruction:
      'Add a reachable test tower, then Back up now. Wait for a remote receipt covering this chapter’s committed frame. Backup coverage and dispute appointments are separate.',
    done: ctx =>
      ctx.backup?.runtimeId === ctx.runtimeId &&
      ctx.backup.entityId === ctx.wallet.entityId &&
      ctx.backup.height >= (ctx.before?.frameHeight ?? Infinity) &&
      ctx.backup.storedBytes > 0,
    skipReason: ctx => (ctx.dom.has('watchtower-error') ? `Tower unavailable: ${ctx.dom.text('watchtower-error')}` : ''),
  },
  recovery: {
    path: '/sovereignty',
    target: 'watchtower-backup-now',
    done: recovered,
    skipReason: () =>
      'New-device recovery requires a separate clean browser profile, the original secret and a reachable tower. Restore there, then open this recovery chapter on the restored wallet. Compare identity, committed balances and a 1 USDC payment; keeping the same secret alone is not recovery.',
  },
  company: {
    path: '/ownership',
    target: 'entity-formation',
    done: formed,
    instruction:
      'Get test gas from Assets. Create a named registered entity, then select it in the entity switcher. Completion requires its new committed identity and board, not the registration submission.',
  },
  shares: {
    path: '/ownership',
    target: 'release-shares',
    instruction:
      'On your new registered company, release treasury shares to the Depository. Wait until both share reserves are committed.',
    // EntityProvider increments before execution: the first release confirms nonce 1.
    // Require both the executed action and its two committed reserve credits.
    done: ctx =>
      committed(ctx) &&
      (core(ctx.wallet)?.entityProviderActionState?.confirmedNonce ?? 0n) > (core(ctx.before!)?.entityProviderActionState?.confirmedNonce ?? 0n) &&
      ctx.shareTokens?.runtimeId === ctx.runtimeId &&
      ctx.shareTokens.entityId === ctx.wallet.entityId &&
      ctx.shareTokens.ids.length === 2 &&
      ctx.shareTokens.ids.every(id => (core(ctx.wallet)?.reserves.get(id) ?? 0n) > (core(ctx.before!)?.reserves.get(id) ?? 0n)),
    skipReason: ctx =>
      !/^0x0{55}[0-9a-f]{9}$/i.test(ctx.wallet.entityId)
        ? 'This self-issued wallet has no share treasury. Create and select a registered company first.'
        : '',
  },
  governance: {
    path: '/ownership',
    target: 'takeover',
    done: ctx =>
      ctx.governance?.runtimeId === ctx.runtimeId &&
      ctx.governance.entityId === ctx.wallet.entityId &&
      ctx.governance.oldHash !== ctx.governance.newHash,
    skipReason: ctx =>
      ctx.takeover?.runtimeId === ctx.runtimeId && ctx.takeover.entityId === ctx.wallet.entityId &&
      ctx.takeover.targetId !== ctx.wallet.entityId && /^0x0{55}[0-9a-f]{9}$/i.test(ctx.takeover.targetId) &&
      ctx.takeover.controlMajority &&
      (/^0x0{64}$/.test(ctx.takeover.proposedBoardHash) ||
        (ctx.takeover.activateAt > 0n && ctx.takeover.currentUnix >= ctx.takeover.activateAt)) ? '' :
      'Requires a separate disposable registered target, settled CONTROL majority and the on-chain activation delay. Do not replace a live company board for this tutorial. A proposal is not activation; read status before proposing and again after activation to verify the confirmed board hash changed to the proposal.',
  },
  dispute: {
    path: accountRoute,
    target: 'account-dispute',
    done: ctx =>
      committed(ctx) &&
      ctx.wallet.accounts.some(
        account =>
          account.dispute === 'closed' &&
          ctx.before!.accounts.some(old => old.counterpartyId === account.counterpartyId && old.dispute !== 'closed'),
      ) &&
      reserve(ctx.wallet) > reserve(ctx.before!),
    skipReason: ctx => {
      const account = ctx.wallet.accounts[0];
      if (!account) return 'Select your original personal wallet: this company has no collateralized account to exit.';
      if (collateral(ctx.wallet) === 0n)
        return 'No collateral is funded on this account. A dispute cannot recover unsecured credit as collateral.';
      const config = account.doc.state.disputeConfig;
      const seconds = Number(config.leftResponseSeconds) + Number(config.rightResponseSeconds);
      return seconds > 120
        ? `This account’s signed challenge windows total ${seconds} seconds. Use the dedicated dispute E2E; this bounded guide does not shorten protocol deadlines.`
        : '';
    },
  },
};

export const FEATURE_CHAPTERS: TourStep[] = WALLET_LESSONS.slice(4).map(lesson => {
  const exercise = exercises[lesson.id]!;
  return {
    id: lesson.id,
    title: lesson.title,
    example: lesson.example,
    instruction: () => exercise.instruction ?? lesson.exercise,
    target: ctx => (lesson.id === 'shares' && !ctx.dom.has('shares') ? 'entity-formation' : exercise.target),
    route: ctx => (typeof exercise.path === 'function' ? exercise.path(ctx) : exercise.path),
    ...(exercise.done ? { done: exercise.done } : {}),
    ...(exercise.skipReason ? { skipReason: exercise.skipReason } : {}),
  };
});

FEATURE_CHAPTERS.splice(FEATURE_CHAPTERS.findIndex(step => step.id === 'repay') + 1, 0, {
  id: 'savings-withdraw',
  title: 'Withdraw your savings',
  route: () => '/lend',
  target: () => 'lending-close',
  instruction: () =>
    'Request withdrawal of your 5 USDC savings. Wait for the signed savings covenant to close. A queued withdrawal is still a claim on the bank.',
  done: ctx => closedClaim(ctx, 'save'),
  skipReason: ctx =>
    claims(ctx.wallet, 'save').length === 0
      ? 'No signed savings position exists. Complete Save first; an unfunded offer cannot be withdrawn.'
      : '',
});
