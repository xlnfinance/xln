import { Transaction, keccak256, type JsonRpcProvider } from 'ethers';
import { EntityProvider__factory } from '../../../typechain-types';
import { computeBatchHankoHash } from '../../../../core/jurisdiction/machine/batch';
import { requireCurrentAuthority, payerSlots, type ExecutionAuthority, type ChainAuthority } from './authority';
import { validateAuthorizedWire } from './calls';
import { broadcastPreparedRpcTransaction } from '../../../../core/jurisdiction/adapter/rpc/write/prepared/prepared-broadcast';
import { readNonceReceipt } from './nonce-receipt';
import { waitForHistory, type ExecutionProviders, type ChainBinding, type NonceGrant } from './providers';

export const verifyEntityHanko = async (
  provider: JsonRpcProvider,
  chain: ChainBinding,
  proof: Readonly<{ hanko: string; hash: string; entityId: string }>,
  blockTag: number | 'latest' = 'latest',
): Promise<void> => {
  const verifier = EntityProvider__factory.connect(chain.entityProvider, provider);
  const [entity, valid] = await verifier.verifyCurrentHankoSignature(proof.hanko, proof.hash, { blockTag });
  if (!valid || entity.toLowerCase() !== proof.entityId) throw new Error('USDC_EXECUTION_HANKO_AUTHORITY_MISMATCH');
};

export const verifyBatchHanko = (
  provider: JsonRpcProvider,
  chain: ChainBinding,
  batch: Readonly<{ encoded: string; hanko: string; nonce: bigint; entityId: string }>,
  blockTag: number | 'latest' = 'latest',
): Promise<void> =>
  verifyEntityHanko(
    provider,
    chain,
    {
      ...batch,
      hash: computeBatchHankoHash(BigInt(chain.chainId), chain.depository, batch.encoded, batch.nonce),
    },
    blockTag,
  );

export const verifyExecutionChain = async (
  providers: ExecutionProviders,
  chain: ChainBinding & Readonly<{ payers: readonly NonceGrant[] }>,
): Promise<void> => {
  const provider = providers.current;
  await waitForHistory(
    `anchor:${chain.chainId}`,
    async () => (await providers.historical.getBlockNumber()) >= chain.anchorNumber,
  );
  for (const reader of [provider, providers.historical]) {
    if ((await reader.getNetwork()).chainId !== BigInt(chain.chainId)) throw new Error('USDC_EXECUTION_CHAIN_MISMATCH');
    if ((await reader.getBlock(chain.anchorNumber))?.hash !== chain.anchorHash)
      throw new Error('USDC_EXECUTION_ANCHOR_CHANGED');
  }
  for (const [address, hash] of Object.entries(chain.codeHashes)) {
    const code = await provider.getCode(address);
    if (code === '0x' || keccak256(code) !== hash) throw new Error('USDC_EXECUTION_CODE_CHANGED');
  }
  for (const payer of chain.payers)
    if ((await providers.historical.getTransactionCount(payer.address, chain.anchorNumber)) !== payer.firstNonce)
      throw new Error('USDC_EXECUTION_NONCE_ANCHOR_MISMATCH');
};

/** Consumed slots remain part of this campaign's allowance after a restart.
 * A different transaction or an older fee above newly supplied limits must not
 * be hidden by counting only the slots which are still unspent. */
export const verifyConsumedPayerSlots = async (
  authority: ExecutionAuthority,
  providers: ExecutionProviders,
  chain: ChainAuthority,
): Promise<void> => {
  for (const payer of chain.payers) {
    const count = await providers.current.getTransactionCount(payer.address, 'latest');
    if (count < payer.firstNonce || count > payer.firstNonce + payerSlots(authority, payer))
      throw new Error('USDC_EXECUTION_PAYER_NONCE_OUTSIDE_SCOPE');
    for (let nonce = payer.firstNonce; nonce < count; nonce++) {
      const known = await readNonceReceipt(providers, chain, payer, nonce);
      if (!known) throw new Error('USDC_EXECUTION_CONSUMED_SLOT_UNRESOLVED');
      validateAuthorizedWire(authority, chain, Transaction.from(known.transaction).serialized);
    }
  }
};

/** Finite nonce grants reserve their full worst-case fee for the entire series.
 * A restart or a same-nonce replacement cannot create another slot or replenish
 * the cumulative allowance. No receipt cache or secondary recovery store exists. */
export const submitAuthorizedWire = async (
  authority: ExecutionAuthority,
  catalogPath: string,
  providers: ExecutionProviders,
  chain: ChainAuthority,
  raw: string,
  runIndex?: number,
): Promise<string> => {
  requireCurrentAuthority(authority, catalogPath);
  const validated = validateAuthorizedWire(authority, chain, raw);
  if (runIndex !== undefined && validated.runIndex !== runIndex)
    throw new Error('USDC_EXECUTION_GATEWAY_RUN_SLOT_MISMATCH');
  await verifyExecutionChain(providers, chain);
  const provider = providers.current;
  if (validated.batch) await verifyBatchHanko(provider, chain, validated.batch);
  const hash = validated.transaction.hash!;
  const existing = await provider.getTransaction(hash);
  if (existing) return hash;
  const confirmedNonce = await provider.getTransactionCount(validated.payer.address, 'latest');
  if (confirmedNonce > validated.transaction.nonce) throw new Error('USDC_EXECUTION_NONCE_ALREADY_CONSUMED');
  const pendingNonce = await provider.getTransactionCount(validated.payer.address, 'pending');
  if (confirmedNonce !== validated.transaction.nonce || pendingNonce !== confirmedNonce)
    throw new Error('USDC_EXECUTION_NONCE_UNRESOLVED');
  if (
    (await provider.getBalance(validated.payer.address)) <
    validated.transaction.gasLimit * validated.transaction.maxFeePerGas!
  )
    throw new Error('USDC_EXECUTION_PAYER_NATIVE_INSUFFICIENT');
  requireCurrentAuthority(authority, catalogPath);
  const accepted = await broadcastPreparedRpcTransaction({ mode: 'rpc', chainId: chain.chainId }, provider, raw);
  if (accepted !== hash) throw new Error('USDC_EXECUTION_BROADCAST_HASH_MISMATCH');
  return accepted;
};
