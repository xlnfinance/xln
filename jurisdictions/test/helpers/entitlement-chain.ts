/**
 * Chain side of the entitlement differential: put seeded single-token states on
 * the production Depository path, dispute them and read back what was paid.
 *
 * Path per account (≤ MAX_DISPUTE_PROOF_TOKENS tokens, unique token ids):
 *   mintToReserve(funder, custody) → funder batch of R2R (reserves) + R2C
 *   (left receiver = ondelta, right receiver = rest of collateral) → left starts a
 *   right-signed dispute → timeout → left finalizes unilaterally.
 */
import hre from 'hardhat';
import { Wallet } from 'ethers';
import {
  Depository__factory,
  DepositoryDebtHarness__factory,
  type Depository,
  type DepositoryDebtHarness,
} from '../../typechain-types/index.js';
import { decodeInt512, decodeUint512, decodeUint768, encodeInt512 } from '../../../core/protocol/crypto/abi-money.ts';
import { PROOF_BODY_ABI } from '../../../core/protocol/dispute/proof-body.ts';
import { UINT256_MAX } from '../../../core/protocol/boundary/integer-ranges.ts';
import {
  hashDepositoryBatchHankoPayload,
  hashDisputeProofHankoPayload,
  type DepositoryHankoDomain,
} from '../../../core/hanko/onchain-domain.ts';
import {
  buildSingleSignerHanko,
  canonicalAccountKey,
  deployDepositoryStack,
  deployEntityProvider,
  emptyBatch,
  encodeBatch,
  singleSignerLazyEntityId,
} from './hanko.ts';
import type { EntitlementCase } from './entitlement-cases.ts';

const { ethers, networkHelpers } = await hre.network.getOrCreate('hardhat');
const abi = ethers.AbiCoder.defaultAbiCoder();

const OPS_PER_BATCH = 50; // DepositoryBounds.MAX_BATCH_TOTAL_OPS
const WATCH_SEED = ethers.keccak256(ethers.toUtf8Bytes('xln:entitlement-watch-seed'));
const THIRD_CREDITOR = ethers.keccak256(ethers.toUtf8Bytes('xln:entitlement-third-creditor'));
const NO_ARGUMENTS = abi.encode(['bytes[]'], [[]]);

type Target = Pick<
  Depository,
  'processBatch' | 'interface' | 'mintToReserve' | '_reserves' | 'debtOutstanding' | '_collaterals' | '_accounts' | 'getAddress'
>;
type Actor = { entityId: string; privateKey: string; nonce: bigint };
export type Stand = Readonly<{ target: Target; harness: DepositoryDebtHarness | null; domain: DepositoryHankoDomain; funder: Actor; seed: bigint }>;
export type Pair = Readonly<{ left: Actor; right: Actor; accountKey: string }>;
export type ChainCase = Readonly<{ state: EntitlementCase; tokenId: number }>;
export type Outcome = Readonly<Record<
  'leftReserve' | 'rightReserve' | 'leftDebtOutstanding' | 'rightDebtOutstanding' | 'collateral' | 'ondelta' | 'newDebtRow' | 'thirdReserve',
  string
>>;

const actorFor = (seed: bigint, label: string, index: number): Actor => {
  const privateKey = ethers.keccak256(abi.encode(['uint256', 'string', 'uint256'], [seed, label, index]));
  return { entityId: singleSignerLazyEntityId(new Wallet(privateKey).address), privateKey, nonce: 0n };
};

export const pairFor = (stand: Stand, group: number): Pair => {
  const a = actorFor(stand.seed, 'pair-a', group);
  const b = actorFor(stand.seed, 'pair-b', group);
  const [left, right] = BigInt(a.entityId) < BigInt(b.entityId) ? [a, b] : [b, a];
  return { left, right, accountKey: canonicalAccountKey(left.entityId, right.entityId) };
};

const submit = async (stand: Stand, actor: Actor, batch: Record<string, unknown>) => {
  const encoded = encodeBatch(batch);
  actor.nonce += 1n;
  const hash = hashDepositoryBatchHankoPayload(stand.domain, encoded, actor.nonce);
  const hanko = buildSingleSignerHanko(actor.entityId, hash, actor.privateKey);
  const receipt = await (await stand.target.processBatch(encoded, hanko, actor.nonce)).wait();
  if (!receipt || receipt.status !== 1) throw new Error(`ENTITLEMENT_BATCH_FAILED:${actor.entityId}`);
  return receipt;
};
export type Receipt = Awaited<ReturnType<typeof submit>>;

const deployHarness = async (
  stack: Awaited<ReturnType<typeof deployDepositoryStack>>,
  entityProviderAddress: string,
): Promise<DepositoryDebtHarness> => {
  const factory = await ethers.getContractFactory('DepositoryDebtHarness', { libraries: {
    Account: await stack.account.getAddress(),
    DepositoryBounds: await stack.depositoryBounds.getAddress(),
    HashLadderRegistry: await stack.hashLadderRegistry.getAddress(),
    NftCustody: await stack.nftCustody.getAddress(),
  } });
  const deployed = await factory.deploy(entityProviderAddress, await stack.deltaTransformer.getAddress());
  await deployed.waitForDeployment();
  return DepositoryDebtHarness__factory.connect(await deployed.getAddress(), (await ethers.getSigners())[0]);
};

/** The production graph; `withHarness` swaps in Depository + debt seeding (same finalize code). */
export const deployStand = async (seed: bigint, withHarness: boolean): Promise<Stand> => {
  const [deployer] = await ethers.getSigners();
  const entityProvider = await deployEntityProvider(deployer!.address);
  const stack = await deployDepositoryStack(await entityProvider.getAddress());
  const harness = withHarness ? await deployHarness(stack, await entityProvider.getAddress()) : null;
  const target: Target = harness ?? Depository__factory.connect(await stack.depository.getAddress(), deployer);
  const domain = { chainId: (await ethers.provider.getNetwork()).chainId, depositoryAddress: await target.getAddress() };
  return { target, harness, domain, funder: actorFor(seed, withHarness ? 'harness-funder' : 'funder', 0), seed };
};

const seedPriorDebt = async (stand: Stand, pair: Pair, item: ChainCase): Promise<void> => {
  const prior = item.state.priorDebt;
  if (prior === null) return;
  if (stand.harness === null) throw new Error('ENTITLEMENT_PRIOR_DEBT_NEEDS_HARNESS');
  const debtor = prior.side === 'left' ? pair.left.entityId : pair.right.entityId;
  const peer = prior.side === 'left' ? pair.right.entityId : pair.left.entityId;
  const creditor = prior.creditor === 'peer' ? peer : THIRD_CREDITOR;
  for (const amount of prior.amounts) {
    if (amount <= UINT256_MAX) await stand.harness.harnessAddDebt(debtor, item.tokenId, creditor, amount);
    else await stand.harness.harnessAddWideDebt(debtor, item.tokenId, creditor, { high: amount >> 256n, low: amount & UINT256_MAX });
  }
};

type FundingOp = readonly ['reserveToReserve' | 'reserveToCollateral', Record<string, unknown>];

/** A left-receiver R2C adds to ondelta; a right-receiver R2C adds custody only. */
const fundingOps = (pair: Pair, item: ChainCase): FundingOp[] => {
  const { collateral, ondelta, leftReserve, rightReserve } = item.state;
  const tokenId = item.tokenId;
  const ops: FundingOp[] = [];
  if (leftReserve > 0n) ops.push(['reserveToReserve', { receivingEntity: pair.left.entityId, tokenId, amount: leftReserve }]);
  if (rightReserve > 0n) ops.push(['reserveToReserve', { receivingEntity: pair.right.entityId, tokenId, amount: rightReserve }]);
  if (ondelta > 0n) ops.push(['reserveToCollateral', { tokenId, receivingEntity: pair.left.entityId, pairs: [{ entity: pair.right.entityId, amount: ondelta }] }]);
  if (collateral > ondelta) {
    ops.push(['reserveToCollateral', { tokenId, receivingEntity: pair.right.entityId, pairs: [{ entity: pair.left.entityId, amount: collateral - ondelta }] }]);
  }
  return ops;
};

const assertFunded = async (stand: Stand, pair: Pair, items: readonly ChainCase[]): Promise<void> => {
  const rows = await Promise.all(items.map(item => stand.target._collaterals(pair.accountKey, item.tokenId)));
  rows.forEach((row, index) => {
    const { state, tokenId } = items[index]!;
    if (row.collateral !== state.collateral || decodeInt512(row.ondelta) !== state.ondelta) {
      throw new Error(`ENTITLEMENT_FUNDING_MISMATCH:${tokenId}:${row.collateral}:${decodeInt512(row.ondelta)}`);
    }
  });
};

/** One mint per token, then as few production batches as the 50-op cap allows. */
export const fundGroup = async (stand: Stand, pair: Pair, items: readonly ChainCase[]): Promise<void> => {
  for (const item of items) {
    const custody = item.state.collateral + item.state.leftReserve + item.state.rightReserve;
    if (custody > 0n) await stand.target.mintToReserve(stand.funder.entityId, item.tokenId, custody);
    await seedPriorDebt(stand, pair, item);
  }
  const ops = items.flatMap(item => fundingOps(pair, item));
  for (let start = 0; start < ops.length; start += OPS_PER_BATCH) {
    const chunk = ops.slice(start, start + OPS_PER_BATCH);
    await submit(stand, stand.funder, emptyBatch({
      reserveToReserve: chunk.filter(([kind]) => kind === 'reserveToReserve').map(([, op]) => op),
      reserveToCollateral: chunk.filter(([kind]) => kind === 'reserveToCollateral').map(([, op]) => op),
    }));
  }
  await assertFunded(stand, pair, items);
};

export const disputeAndFinalize = async (stand: Stand, pair: Pair, items: readonly ChainCase[]): Promise<Receipt> => {
  const proofbody = {
    watchSeed: WATCH_SEED,
    leftResponseSeconds: 50,
    rightResponseSeconds: 50,
    offdeltas: items.map(item => encodeInt512(item.state.offdelta)),
    tokenIds: items.map(item => BigInt(item.tokenId)),
    transformers: [],
  };
  const proofbodyHash = ethers.keccak256(abi.encode([ethers.ParamType.from(PROOF_BODY_ABI)], [proofbody]));
  const startHash = hashDisputeProofHankoPayload(stand.domain, pair.accountKey, 1n, false, proofbodyHash, WATCH_SEED);
  await submit(stand, pair.left, emptyBatch({ disputeStarts: [{
    counterentity: pair.right.entityId, nonce: 1n, proposerIsLeft: false, proofbodyHash,
    initialProofbody: proofbody, watchSeed: WATCH_SEED,
    sig: buildSingleSignerHanko(pair.right.entityId, startHash, pair.right.privateKey),
    starterInitialArguments: NO_ARGUMENTS, starterCounterArguments: '0x', starterCounterProofCommitment: ethers.ZeroHash,
  }] }));
  const timeout = (await stand.target._accounts(pair.accountKey)).disputeTimeout;
  await networkHelpers.time.increaseTo(Number(timeout + 1n));
  return submit(stand, pair.left, emptyBatch({ disputeFinalizations: [{
    counterentity: pair.right.entityId, initialNonce: 1n, finalNonce: 1n, proposerIsLeft: false,
    initialProofbodyHash: proofbodyHash, finalProofbody: proofbody, starterArguments: NO_ARGUMENTS,
    otherArguments: '0x', sig: '0x', startedByLeft: true, cooperative: false,
  }] }));
};

/** Every DebtCreated row the finalization emitted, keyed by token: extra or missing rows both show. */
export const createdDebtRows = (stand: Stand, receipt: Receipt): Map<bigint, string> => {
  const rows = new Map<bigint, string>();
  for (const log of receipt.logs) {
    const parsed = stand.target.interface.parseLog(log);
    if (parsed?.name !== 'DebtCreated') continue;
    const [, creditor, tokenId, amount, index] = parsed.args;
    const row = `${index}:${creditor}:${decodeUint512(amount)}`;
    rows.set(tokenId, rows.has(tokenId) ? `${rows.get(tokenId)}|${row}` : row);
  }
  return rows;
};

export const readOutcome = async (stand: Stand, pair: Pair, item: ChainCase, debtRows: Map<bigint, string>): Promise<Outcome> => {
  const target = stand.target;
  const [leftReserve, rightReserve, leftDebt, rightDebt, collateral, thirdReserve] = await Promise.all([
    target._reserves(pair.left.entityId, item.tokenId),
    target._reserves(pair.right.entityId, item.tokenId),
    target.debtOutstanding(pair.left.entityId, item.tokenId),
    target.debtOutstanding(pair.right.entityId, item.tokenId),
    target._collaterals(pair.accountKey, item.tokenId),
    item.state.priorDebt?.creditor === 'third' ? target._reserves(THIRD_CREDITOR, item.tokenId) : Promise.resolve(0n),
  ]);
  return {
    leftReserve: leftReserve.toString(),
    rightReserve: rightReserve.toString(),
    leftDebtOutstanding: decodeUint768(leftDebt).toString(),
    rightDebtOutstanding: decodeUint768(rightDebt).toString(),
    collateral: collateral.collateral.toString(),
    ondelta: decodeInt512(collateral.ondelta).toString(),
    newDebtRow: debtRows.get(BigInt(item.tokenId)) ?? 'none',
    thirdReserve: thirdReserve.toString(),
  };
};
