import { writeFileSync } from 'node:fs';
import { Wallet, Transaction } from 'ethers';
import { safeStringify } from '../../../../core/protocol/serialization';
import { broadcastPreparedRpcTransaction } from '../../../../core/jurisdiction/adapter/rpc/write/prepared/prepared-broadcast';
import { acquireStoreOwnership } from '../operators/session/stores';
import { readExistingIdentities } from '../identities';
import { verifyExecutionChain, verifyBatchHanko } from '../execution/submission';
import type { ExecutionProviders } from '../execution/providers';
import {
  readFundingAuthority,
  requireFundingAuthority,
  fundingDigest,
  fundingSlots,
  type FundingChain,
} from './authority';
import { fundingProviders } from './providers';
import { signFundingWires, validateFundingWire } from './wires';
import { checkFundingProgress, waitFundingReceipt } from './ledger';
import type { FundingConfig } from './config';

const requireBindings = (config: FundingConfig, chains: readonly FundingChain[]): void => {
  const identities = readExistingIdentities(config.directory, config.userVault);
  for (const chain of chains) {
    const hub = identities.find(role => role.role === 'hub')!.chains.find(value => value.chainId === chain.chainId)!;
    const user = identities.find(role => role.role === 'user')!.chains.find(value => value.chainId === chain.chainId)!;
    if (
      hub.entityId !== chain.hubEntity ||
      hub.signerId !== chain.hubSigner ||
      (chain.limits.userFunding && user.signerId !== chain.limits.userFunding.signer) ||
      identities.some(role => role.chains.some(value => value.signerId === chain.funder.address))
    )
      throw new Error('USDC_FUNDING_VAULT_BINDING_MISMATCH');
  }
};

const submitSlot = async (
  providers: ExecutionProviders,
  chain: FundingChain,
  raw: string,
  requireAuthority: () => void,
  observed?: (chainId: number, stage: string, hash: string) => void,
): Promise<void> => {
  const validated = validateFundingWire(chain, raw);
  await verifyExecutionChain(providers, { ...chain, payers: [chain.funder] });
  const provider = providers.current;
  const hash = validated.transaction.hash!;
  const known = await provider.getTransaction(hash);
  if (!known) {
    const nonce = await provider.getTransactionCount(chain.funder.address, 'latest');
    if (
      nonce !== validated.transaction.nonce ||
      (await provider.getTransactionCount(chain.funder.address, 'pending')) !== nonce
    )
      throw new Error('USDC_FUNDING_UNRESOLVED_PENDING_NONCE');
    if (validated.batch) await verifyBatchHanko(provider, chain, validated.batch);
    const estimate = await provider.estimateGas({
      from: chain.funder.address,
      to: validated.transaction.to,
      data: validated.transaction.data,
      value: validated.transaction.value,
    });
    const block = await provider.getBlock('latest');
    if (
      !block ||
      block.baseFeePerGas === null ||
      estimate > validated.transaction.gasLimit ||
      block.baseFeePerGas + validated.transaction.maxPriorityFeePerGas! > validated.transaction.maxFeePerGas!
    )
      throw new Error('USDC_FUNDING_CURRENT_FEE_LIMIT_INSUFFICIENT');
    requireAuthority();
    console.log(`USDC_FUNDING_BROADCAST_ATTEMPT:${chain.chainId}:${validated.stage}:${hash}`);
    const accepted = await broadcastPreparedRpcTransaction({ mode: 'rpc', chainId: chain.chainId }, provider, raw);
    if (accepted !== hash) throw new Error('USDC_FUNDING_BROADCAST_HASH_MISMATCH');
    if (observed) observed(chain.chainId, validated.stage, hash);
  }
  await waitFundingReceipt(provider, hash);
};

/** Ordinary host observers may record a broadcast before confirmation. They
 * have no financial authority; chain history alone reconstructs spent slots. */
export const runFunding = async (
  config: FundingConfig,
  observed?: (chainId: number, stage: string, hash: string) => void,
): Promise<void> => {
  const authority = readFundingAuthority(config.authorityPath);
  const requireAuthority = () => requireFundingAuthority(authority, config.catalogPath);
  requireAuthority();
  requireBindings(config, authority.chains);
  const secret = process.env[config.keyEnv] ?? '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(secret)) throw new Error('USDC_FUNDING_SIGNER_KEY_REQUIRED');
  const signer = new Wallet(secret);
  if (authority.chains.some(chain => chain.funder.address !== signer.address.toLowerCase()))
    throw new Error('USDC_FUNDING_SIGNER_ADDRESS_MISMATCH');
  const release = acquireStoreOwnership([['funding', config.directory]]);
  const providers = authority.chains.map(chain => fundingProviders(chain.chainId, 'write'));
  try {
    for (const [index, chain] of authority.chains.entries()) {
      await verifyExecutionChain(providers[index]!, { ...chain, payers: [chain.funder] });
      await checkFundingProgress(providers[index]!, chain);
    }
    const results = [];
    for (const [index, chain] of authority.chains.entries()) {
      const connection = providers[index]!;
      requireAuthority();
      const wires = await signFundingWires(chain, signer);
      const slots = fundingSlots(chain.limits);
      for (const [slot, { stage }] of slots.entries()) {
        const progress = await checkFundingProgress(connection, chain);
        if (progress.entries.length > slot) continue;
        requireAuthority();
        await submitSlot(connection, chain, wires[slot]!, requireAuthority, observed);
        console.log(`USDC_FUNDING_CONFIRMED:${chain.chainId}:${stage}`);
      }
      const ledger = await checkFundingProgress(connection, chain);
      if (ledger.entries.length !== slots.length) throw new Error('USDC_FUNDING_INCOMPLETE');
      results.push({
        chainId: chain.chainId,
        funder: chain.funder.address,
        hubEntity: chain.hubEntity,
        hubSigner: chain.hubSigner,
        before: ledger.before,
        after: ledger.after,
        feesWei: ledger.fees,
        nativeValueWei: ledger.value,
        usdcAtomic: ledger.deposited,
        ...(chain.limits.userFunding ? {
          userSigner: chain.limits.userFunding.signer,
          userUsdcAtomic: ledger.userUsdc,
          userNativeWei: ledger.userNative,
        } : {}),
        receipts: ledger.entries.map(entry => ({
          stage: entry.stage,
          hash: entry.transaction.hash,
          raw: Transaction.from(entry.transaction).serialized,
          transaction: entry.transaction.toJSON() as unknown,
          receipt: entry.receipt.toJSON() as unknown,
        })),
      });
    }
    writeFileSync(
      config.output,
      safeStringify(
        {
          status: 'funded-on-chain',
          authorityDigest: fundingDigest(authority),
          chains: results,
          executionScope: 'configured-rpc',
          runtimeObservation:
            'Required separately through the original Hub/MM Runtime WAL and authenticated J observation.',
        },
        2,
      ),
      { mode: 0o600, flag: 'wx' },
    );
    console.log(`USDC_FUNDING_ONCHAIN_COMPLETE:${config.output}`);
  } finally {
    for (const connection of providers) {
      connection.current.destroy();
      connection.historical.destroy();
    }
    release();
  }
};
