/**
 * K1 entitlement differential: what the TypeScript mirror says each side is
 * entitled to at dispute finalization equals what Depository pays out.
 *
 * TS side: `deriveDisputeTokenFinalization` (core/protocol/dispute/finalization.ts),
 * the canonical pure mirror of Depository._applyAccountDelta + _settleShortfall.
 * Chain side: the production processBatch path (helpers/entitlement-chain.ts) on
 * seeded single-token states (helpers/entitlement-cases.ts). Each account carries
 * up to MAX_DISPUTE_PROOF_TOKENS (128) independent token states in one proof; token
 * ids never repeat, so cases cannot interfere.
 *
 * Prior FIFO debt needs DepositoryDebtHarness (Depository + debt seeding only).
 * The mirror leaves FIFO routing to its caller; entitlement-cases.ts is that caller.
 *
 * Seed: XLN_ENTITLEMENT_SEED (hex) overrides the fixed default; it is logged.
 * Size: XLN_ENTITLEMENT_GROUPS (accounts of 128 states) overrides the default 24.
 */
import { expect } from 'chai';
import { UINT256_MAX } from '../../../core/protocol/boundary/integer-ranges.ts';
import {
  DELTA_REGIMES,
  boundaryStates,
  createRng,
  expectEntitlement,
  generateCase,
  type EntitlementCase,
  type EntitlementExpectation,
  type PriorKind,
  type Rng,
} from '../helpers/entitlement-cases.ts';
import {
  createdDebtRows,
  deployStand,
  disputeAndFinalize,
  fundGroup,
  pairFor,
  readOutcome,
  type ChainCase,
  type Outcome,
  type Pair,
  type Stand,
} from '../helpers/entitlement-chain.ts';

const DEFAULT_SEED = 0x6b31_656e_7469_746cn; // "k1entitl"
const SEED = BigInt(process.env.XLN_ENTITLEMENT_SEED ?? DEFAULT_SEED);
const GROUP_SIZE = 128; // Account.MAX_DISPUTE_PROOF_TOKENS
// 24 accounts × 128 tokens = 3,072 on-chain states in ~25 s. A campaign of
// 79 groups (10,112 states) runs in ~75 s: XLN_ENTITLEMENT_GROUPS=79.
const PRODUCTION_GROUPS = Number(process.env.XLN_ENTITLEMENT_GROUPS ?? 24);
if (!Number.isSafeInteger(PRODUCTION_GROUPS) || PRODUCTION_GROUPS < 1) throw new Error(`ENTITLEMENT_GROUPS_INVALID:${PRODUCTION_GROUPS}`);
const DEEP_QUEUE_CASES = 40;

type Planned = ChainCase & Readonly<{ expected: EntitlementExpectation }>;
type Mismatch = Readonly<{ tokenId: number; state: EntitlementCase; expected: Outcome; actual: Outcome }>;

const expectedOutcome = (pair: Pair, item: Planned): Outcome => {
  const { mirror, debtorSide, sweep, newDebtIndex } = item.expected;
  const newDebt = debtorSide === 'left' ? mirror.newDebt.leftToRight : mirror.newDebt.rightToLeft;
  const creditor = debtorSide === 'left' ? pair.right.entityId : pair.left.entityId;
  const third = item.state.priorDebt?.creditor === 'third' && sweep !== null ? sweep.paid : 0n;
  return {
    leftReserve: mirror.after.reserves.left.toString(),
    rightReserve: mirror.after.reserves.right.toString(),
    leftDebtOutstanding: mirror.after.debtOutstanding.left.toString(),
    rightDebtOutstanding: mirror.after.debtOutstanding.right.toString(),
    collateral: mirror.after.collateral.toString(),
    ondelta: mirror.after.ondelta.toString(),
    newDebtRow: newDebt > 0n ? `${newDebtIndex}:${creditor}:${newDebt}` : 'none',
    thirdReserve: third.toString(),
  };
};

const runGroup = async (stand: Stand, group: number, firstTokenId: number, states: readonly EntitlementCase[]) => {
  const pair = pairFor(stand, group);
  const items = states.map((state, index): Planned => {
    const tokenId = firstTokenId + index;
    return { state, tokenId, expected: expectEntitlement(state, tokenId) };
  });
  await fundGroup(stand, pair, items);
  const receipt = await disputeAndFinalize(stand, pair, items);
  const debtRows = createdDebtRows(stand, receipt);
  const mismatches: Mismatch[] = [];
  for (const item of items) {
    const expected = expectedOutcome(pair, item);
    const actual = await readOutcome(stand, pair, item, debtRows);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches.push({ tokenId: item.tokenId, state: item.state, expected, actual });
  }
  return { items, mismatches, gasUsed: receipt.gasUsed };
};

const bitSize = (state: EntitlementCase): number =>
  [state.collateral, state.ondelta, state.offdelta, state.leftReserve, state.rightReserve]
    .reduce((total, value) => total + (value < 0n ? -value : value).toString(2).length, 0);

const coverageKey = (item: Planned): string => {
  const { mirror, debtorSide, sweep } = item.expected;
  if (debtorSide === null) return item.state.regime;
  const shortfall = debtorSide === 'left' ? mirror.shortfall.leftToRight : mirror.shortfall.rightToLeft;
  const reserve = mirror.before.reserves[debtorSide];
  const debt = mirror.before.debtOutstanding[debtorSide];
  const free = reserve > debt ? reserve - debt : 0n;
  const kind = free === 0n ? 'reserve-zero' : free < shortfall ? 'reserve-partial' : free === shortfall ? 'reserve-exact' : 'reserve-full';
  // Reserve left after one FIFO chunk while unswept slots still lock it.
  const lockedTail = sweep !== null && sweep.reserve > 0n && sweep.outstanding > 0n ? '/locked-tail' : '';
  return `${item.state.regime}/${kind}${lockedTail}`;
};

const runCampaign = async (label: string, stand: Stand, states: readonly EntitlementCase[]) => {
  const started = performance.now();
  const coverage = new Map<string, number>();
  const mismatches: Mismatch[] = [];
  const gas: bigint[] = [];
  for (let group = 0; group * GROUP_SIZE < states.length; group++) {
    const slice = states.slice(group * GROUP_SIZE, (group + 1) * GROUP_SIZE);
    const result = await runGroup(stand, group, 1 + group * GROUP_SIZE, slice);
    result.items.forEach(item => coverage.set(coverageKey(item), (coverage.get(coverageKey(item)) ?? 0) + 1));
    mismatches.push(...result.mismatches);
    gas.push(result.gasUsed);
  }
  const wallMs = Math.round(performance.now() - started);
  console.log(`[entitlement] ${label} seed=0x${SEED.toString(16)} cases=${states.length} mismatches=${mismatches.length} wallMs=${wallMs} maxFinalizeGas=${gas.reduce((a, b) => (a > b ? a : b), 0n)}`);
  console.log(`[entitlement] ${label} coverage ${JSON.stringify(Object.fromEntries([...coverage].sort()))}`);
  if (mismatches.length > 0) {
    const smallest = [...mismatches].sort((a, b) => bitSize(a.state) - bitSize(b.state))[0]!;
    console.log(`[entitlement] ${label} smallest counterexample ${JSON.stringify(smallest, (_, value) => typeof value === 'bigint' ? value.toString() : value)}`);
  }
  return { coverage, mismatches };
};

const seededStates = (rng: Rng, count: number, prior: PriorKind): EntitlementCase[] =>
  Array.from({ length: count }, (_, index) => generateCase(rng, DELTA_REGIMES[index % DELTA_REGIMES.length]!, prior));

/** 33 prior slots: Depository sweeps only DEBT_ENFORCEMENT_CHUNK (32) before the shortfall. */
const chunkBoundaryStates = (): EntitlementCase[] => [1000n, 325n].map(leftReserve => ({
  regime: 'left-debt', collateral: 100n, ondelta: 40n, offdelta: -90n,
  leftCreditLimit: 50n, rightCreditLimit: 0n, leftReserve, rightReserve: 7n,
  priorDebt: { side: 'left', creditor: 'third', amounts: Array.from({ length: 33 }, () => 10n) },
}));

describe('Dispute entitlement: TS mirror == Depository finalization', () => {
  it('settles seeded single-token states exactly as deriveDisputeTokenFinalization', async function () {
    this.timeout(180_000);
    const stand = await deployStand(SEED, false);
    const fixed = boundaryStates();
    const states = [...fixed, ...seededStates(createRng(SEED), PRODUCTION_GROUPS * GROUP_SIZE - fixed.length, 'none')];
    const { coverage, mismatches } = await runCampaign('production', stand, states);
    for (const regime of ['left-debt', 'right-debt']) {
      for (const kind of ['reserve-zero', 'reserve-partial', 'reserve-exact', 'reserve-full']) {
        expect(coverage.get(`${regime}/${kind}`) ?? 0, `${regime}/${kind} coverage`).to.be.greaterThan(0);
      }
    }
    expect(states.some(state => state.collateral === 0n), 'collateral 0 coverage').to.equal(true);
    expect(states.some(state => state.collateral === UINT256_MAX), 'collateral max coverage').to.equal(true);
    expect(mismatches).to.deep.equal([]);
  });

  it('sweeps prior FIFO debt before the shortfall, then settles as the mirror says', async function () {
    this.timeout(120_000);
    const stand = await deployStand(SEED, true);
    const rng = createRng(SEED ^ 0xdeb7n);
    // Group 0: 128 shallow/wide queues. Group 1: queues longer than one FIFO chunk.
    const states = [
      ...chunkBoundaryStates(),
      ...seededStates(rng, (GROUP_SIZE - 2) / 2, 'shallow'),
      ...seededStates(rng, (GROUP_SIZE - 2) / 2, 'wide'),
      ...seededStates(rng, DEEP_QUEUE_CASES, 'deep'),
    ];
    const { coverage, mismatches } = await runCampaign('prior-debt', stand, states);
    const lockedTail = [...coverage].filter(([key]) => key.endsWith('/locked-tail')).reduce((total, [, count]) => total + count, 0);
    expect(lockedTail, 'reserve locked by an unswept FIFO tail').to.be.greaterThan(1);
    expect(mismatches).to.deep.equal([]);
  });
});
