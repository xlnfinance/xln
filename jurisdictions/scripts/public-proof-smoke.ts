#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ethers } from 'ethers';

import { generateLazyEntityId } from '../../runtime/entity/factory';
import { buildSingleSignerHanko, prepareSignedBatch } from '../../runtime/hanko/batch';
import {
  hashCooperativeUpdateHankoPayload,
  hashDisputeProofHankoPayload,
} from '../../runtime/hanko/onchain-domain';
import { createEmptyBatch, type JBatch } from '../../runtime/jurisdiction/machine/batch';
import { PROOF_BODY_ABI } from '../../runtime/protocol/dispute/proof-body';
import { Depository__factory } from '../typechain-types/factories/contracts/Depository.sol/Depository__factory';

type PublicJurisdiction = Readonly<{
  chainId: number;
  rpc: string;
  contracts: Readonly<{ depository: string }>;
  tokens: Readonly<{ USDT: Readonly<{ address: string; tokenId: number }> }>;
}>;

const argument = (name: string): string | undefined => {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
};

const privateKey = String(process.env['PUBLIC_CHAIN_PRIVATE_KEY'] || '').trim();
const jurisdictionId = argument('--jurisdiction') || '';
const depositAmount = BigInt(argument('--deposit') || '1000');
const settlementAmount = BigInt(argument('--settle') || '100');
const withdrawalAmount = BigInt(argument('--withdraw') || '50');
const allowTestTokenMint = process.env['PUBLIC_PROOF_ALLOW_TEST_TOKEN_MINT'] === '1';
if (!/^0x[0-9a-f]{64}$/i.test(privateKey)) throw new Error('PUBLIC_PROOF_PRIVATE_KEY_REQUIRED');
if (!jurisdictionId) throw new Error('PUBLIC_PROOF_JURISDICTION_REQUIRED');
if (depositAmount <= settlementAmount + withdrawalAmount || settlementAmount <= 0n || withdrawalAmount <= 0n) {
  throw new Error(`PUBLIC_PROOF_AMOUNTS_INVALID:${depositAmount}:${settlementAmount}:${withdrawalAmount}`);
}

const allJurisdictions = JSON.parse(
  readFileSync(resolve(process.cwd(), 'jurisdictions/jurisdictions.json'), 'utf8'),
) as { jurisdictions?: Record<string, PublicJurisdiction> };
const jurisdiction = allJurisdictions.jurisdictions?.[jurisdictionId];
if (!jurisdiction) throw new Error(`PUBLIC_PROOF_JURISDICTION_UNKNOWN:${jurisdictionId}`);
if (jurisdiction.tokens.USDT.tokenId !== 1) throw new Error('PUBLIC_PROOF_USDT_TOKEN_ID_INVALID');

const provider = new ethers.JsonRpcProvider(jurisdiction.rpc);
const wallet = new ethers.Wallet(privateKey, provider);
const depository = Depository__factory.connect(jurisdiction.contracts.depository, wallet);
const token = new ethers.Contract(
  jurisdiction.tokens.USDT.address,
  [
    'function approve(address spender,uint256 amount) returns (bool)',
    'function allowance(address owner,address spender) view returns (uint256)',
    'function balanceOf(address owner) view returns (uint256)',
    'function mint(address to,uint256 amount)',
  ],
  wallet,
);
const tokenAllowance = token.getFunction('allowance');
const tokenApprove = token.getFunction('approve');
const tokenBalanceOf = token.getFunction('balanceOf');
const tokenMint = token.getFunction('mint');
const ownerEntityId = generateLazyEntityId([wallet.address], 1n);
const counterpartyPrivateKey = ethers.keccak256(
  ethers.solidityPacked(['string', 'bytes32'], ['xln:public-proof-counterparty', privateKey]),
);
const counterpartyWallet = new ethers.Wallet(counterpartyPrivateKey);
const counterpartyEntityId = generateLazyEntityId([counterpartyWallet.address], 1n);
const ownerIsLeft = BigInt(ownerEntityId) < BigInt(counterpartyEntityId);
const leftEntityId = ownerIsLeft ? ownerEntityId : counterpartyEntityId;
const rightEntityId = ownerIsLeft ? counterpartyEntityId : ownerEntityId;
const domain = {
  chainId: BigInt(jurisdiction.chainId),
  depositoryAddress: jurisdiction.contracts.depository,
};
const watchSeed = ethers.keccak256(
  ethers.solidityPacked(['string', 'address'], ['xln:public-proof-watch', wallet.address]),
);
const proofBody = {
  watchSeed,
  leftResponseSeconds: 5,
  rightResponseSeconds: 5,
  offdeltas: [] as bigint[],
  tokenIds: [] as bigint[],
  transformers: [],
};
const proofBodyHash = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode([ethers.ParamType.from(PROOF_BODY_ABI)], [proofBody]),
);

const gasOverrides = async (
  estimate: () => Promise<bigint>,
): Promise<{ gasLimit: bigint }> => {
  const estimated = await estimate();
  return { gasLimit: (estimated * 12n + 9n) / 10n };
};

const sendBatch = async (
  batch: JBatch,
): Promise<ethers.TransactionReceipt> => {
  const currentNonce = await depository.entityNonces(ownerEntityId);
  const signed = prepareSignedBatch(
    batch,
    ownerEntityId,
    privateKey,
    BigInt(jurisdiction.chainId),
    jurisdiction.contracts.depository,
    currentNonce,
  );
  const overrides = await gasOverrides(
    () => depository.processBatch.estimateGas(signed.encodedBatch, signed.hankoData, signed.nextNonce),
  );
  const transaction = await depository.processBatch(
    signed.encodedBatch,
    signed.hankoData,
    signed.nextNonce,
    overrides,
  );
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`PUBLIC_PROOF_BATCH_FAILED:${transaction.hash}`);
  return receipt;
};

const assertCustomError = async (
  action: () => Promise<unknown>,
  expectedName: string,
): Promise<void> => {
  try {
    await action();
  } catch (error) {
    const data = (error as { data?: unknown; info?: { error?: { data?: unknown } } }).data
      ?? (error as { info?: { error?: { data?: unknown } } }).info?.error?.data;
    if (typeof data === 'string') {
      const parsed = depository.interface.parseError(data);
      if (parsed?.name === expectedName) return;
    }
    throw error;
  }
  throw new Error(`PUBLIC_PROOF_EXPECTED_REVERT_MISSING:${expectedName}`);
};

const waitForUnixTimestamp = async (targetTimestamp: number): Promise<void> => {
  for (;;) {
    const block = await provider.getBlock('latest');
    if (!block) throw new Error('PUBLIC_PROOF_LATEST_BLOCK_MISSING');
    if (block.timestamp >= targetTimestamp) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 4_000));
  }
};

try {
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(jurisdiction.chainId)) {
    throw new Error(`PUBLIC_PROOF_CHAIN_ID_MISMATCH:${network.chainId}:${jurisdiction.chainId}`);
  }
  const [leftEntity, rightEntity] = BigInt(ownerEntityId) < BigInt(counterpartyEntityId)
    ? [ownerEntityId, counterpartyEntityId]
    : [counterpartyEntityId, ownerEntityId];
  const accountKey = ethers.solidityPacked(['bytes32', 'bytes32'], [leftEntity, rightEntity]);
  const accountBefore = await depository._accounts(accountKey);
  const ownerReserveBefore = await depository._reserves(ownerEntityId, 1) as bigint;
  const counterpartyReserveBefore = await depository._reserves(counterpartyEntityId, 1) as bigint;
  let tokenMintTransactionHash: string | null = null;
  const tokenBalance = await tokenBalanceOf(wallet.address) as bigint;
  if (tokenBalance < depositAmount) {
    if (!allowTestTokenMint) {
      throw new Error(
        `PUBLIC_PROOF_TOKEN_BALANCE_INSUFFICIENT:` +
        `balance=${tokenBalance}:required=${depositAmount}`,
      );
    }
    const mint = await tokenMint(
      wallet.address,
      depositAmount - tokenBalance,
      await gasOverrides(() => tokenMint.estimateGas(wallet.address, depositAmount - tokenBalance)),
    );
    const receipt = await mint.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`PUBLIC_PROOF_TEST_TOKEN_MINT_FAILED:${mint.hash}`);
    tokenMintTransactionHash = mint.hash;
  }

  const allowance = await tokenAllowance(wallet.address, jurisdiction.contracts.depository) as bigint;
  if (allowance < depositAmount) {
    const approval = await tokenApprove(
      jurisdiction.contracts.depository,
      ethers.MaxUint256,
      await gasOverrides(
        () => tokenApprove.estimateGas(jurisdiction.contracts.depository, ethers.MaxUint256),
      ),
    );
    await approval.wait();
  }

  const deposit = createEmptyBatch();
  deposit.externalTokenToReserve.push({
    entity: ownerEntityId,
    contractAddress: jurisdiction.tokens.USDT.address,
    externalTokenId: 0n,
    tokenType: 0,
    internalTokenId: 1,
    amount: depositAmount,
  });
  const depositReceipt = await sendBatch(deposit);

  const settlementNonce = (accountBefore.nonce as bigint) + 1n;
  const diffs = [{
    tokenId: 1,
    leftDiff: ownerIsLeft ? -settlementAmount : settlementAmount,
    rightDiff: ownerIsLeft ? settlementAmount : -settlementAmount,
    collateralDiff: 0n,
    ondeltaDiff: 0n,
  }];
  const settlementHash = hashCooperativeUpdateHankoPayload(
    domain,
    accountKey,
    settlementNonce,
    diffs,
    [],
  );
  const settlement = createEmptyBatch();
  settlement.settlements.push({
    leftEntity: leftEntityId,
    rightEntity: rightEntityId,
    diffs,
    forgiveDebtsInTokenIds: [],
    sig: buildSingleSignerHanko(counterpartyEntityId, settlementHash, counterpartyPrivateKey),
    nonce: Number(settlementNonce),
  });
  const settlementReceipt = await sendBatch(settlement);

  const replayNonce = await depository.entityNonces(ownerEntityId) + 1n;
  const replaySigned = prepareSignedBatch(
    settlement,
    ownerEntityId,
    privateKey,
    BigInt(jurisdiction.chainId),
    jurisdiction.contracts.depository,
    replayNonce - 1n,
  );
  await assertCustomError(
    () => depository.processBatch.staticCall(
      replaySigned.encodedBatch,
      replaySigned.hankoData,
      replaySigned.nextNonce,
    ),
    'E2',
  );

  // Cooperative dispute finalization is deliberately not a production path:
  // Depository rejects it with E2. Start the canonical timed dispute directly
  // from the last bilaterally settled nonce and prove the timeout path below.
  const disputeNonce = settlementNonce + 1n;
  const disputeHash = hashDisputeProofHankoPayload(
    domain,
    accountKey,
    disputeNonce,
    proofBodyHash,
    watchSeed,
  );
  const disputeStart = createEmptyBatch();
  disputeStart.disputeStarts.push({
    counterentity: counterpartyEntityId,
    nonce: Number(disputeNonce),
    proofbodyHash: proofBodyHash,
    initialProofbody: proofBody,
    watchSeed,
    sig: buildSingleSignerHanko(counterpartyEntityId, disputeHash, counterpartyPrivateKey),
    starterInitialArguments: '0x',
    starterCounterArguments: '0x',
  });
  const disputeStartReceipt = await sendBatch(disputeStart);
  const startedAccount = await depository._accounts(accountKey);
  if (startedAccount.disputeHash === ethers.ZeroHash) throw new Error('PUBLIC_PROOF_DISPUTE_NOT_STARTED');

  const finalization = createEmptyBatch();
  finalization.disputeFinalizations.push({
    counterentity: counterpartyEntityId,
    initialNonce: Number(disputeNonce),
    finalNonce: Number(disputeNonce),
    initialProofbodyHash: proofBodyHash,
    finalProofbody: proofBody,
    starterArguments: '0x',
    otherArguments: '0x',
    sig: '0x',
    startedByLeft: ownerIsLeft,
    cooperative: false,
  });
  const tooEarlyNonce = await depository.entityNonces(ownerEntityId);
  const tooEarly = prepareSignedBatch(
    finalization,
    ownerEntityId,
    privateKey,
    BigInt(jurisdiction.chainId),
    jurisdiction.contracts.depository,
    tooEarlyNonce,
  );
  await assertCustomError(
    () => depository.processBatch.staticCall(
      tooEarly.encodedBatch,
      tooEarly.hankoData,
      tooEarly.nextNonce,
    ),
    'E2',
  );

  const targetTimestamp = Number(startedAccount.disputeTimeout);
  await waitForUnixTimestamp(targetTimestamp);
  const finalizationReceipt = await sendBatch(finalization);
  const finalizedAccount = await depository._accounts(accountKey);
  if (finalizedAccount.disputeHash !== ethers.ZeroHash || finalizedAccount.disputeTimeout !== 0n) {
    throw new Error('PUBLIC_PROOF_DISPUTE_NOT_FINALIZED');
  }

  const tokenBalanceBeforeWithdrawal = await tokenBalanceOf(wallet.address) as bigint;
  const withdrawal = createEmptyBatch();
  withdrawal.reserveToExternalToken.push({
    receivingEntity: ethers.zeroPadValue(wallet.address, 32),
    tokenId: 1,
    amount: withdrawalAmount,
  });
  const withdrawalReceipt = await sendBatch(withdrawal);
  const tokenBalanceAfterWithdrawal = await tokenBalanceOf(wallet.address) as bigint;
  if (tokenBalanceAfterWithdrawal !== tokenBalanceBeforeWithdrawal + withdrawalAmount) {
    throw new Error(
      `PUBLIC_PROOF_WITHDRAWAL_TOKEN_DELTA_MISMATCH:` +
      `before=${tokenBalanceBeforeWithdrawal}:after=${tokenBalanceAfterWithdrawal}:amount=${withdrawalAmount}`,
    );
  }

  const ownerReserve = await depository._reserves(ownerEntityId, 1);
  const counterpartyReserve = await depository._reserves(counterpartyEntityId, 1);
  const expectedOwnerReserve = ownerReserveBefore + depositAmount - settlementAmount - withdrawalAmount;
  const expectedCounterpartyReserve = counterpartyReserveBefore + settlementAmount;
  if (ownerReserve !== expectedOwnerReserve || counterpartyReserve !== expectedCounterpartyReserve) {
    throw new Error(
      `PUBLIC_PROOF_RESERVE_PARITY_MISMATCH:` +
      `owner=${ownerReserve}:${expectedOwnerReserve}:` +
      `counterparty=${counterpartyReserve}:${expectedCounterpartyReserve}`,
    );
  }
  console.log(JSON.stringify({
    kind: 'PUBLIC_PROOF_SMOKE',
    jurisdictionId,
    compiler: '0.8.36',
    ownerEntityId,
    counterpartyEntityId,
    accountKey,
    tokenMintTransactionHash,
    depositTransactionHash: depositReceipt.hash,
    settlementTransactionHash: settlementReceipt.hash,
    disputeStartTransactionHash: disputeStartReceipt.hash,
    disputeFinalizeTransactionHash: finalizationReceipt.hash,
    withdrawalTransactionHash: withdrawalReceipt.hash,
    disputeWindowSeconds: proofBody.leftResponseSeconds + proofBody.rightResponseSeconds,
    ownerReserve: ownerReserve.toString(),
    counterpartyReserve: counterpartyReserve.toString(),
  }));
} finally {
  provider.destroy();
}
