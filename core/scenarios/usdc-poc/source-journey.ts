import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JsonRpcProvider, NonceManager, Wallet } from 'ethers';
import { readCliOption } from '../../config/cli';
import { isLoopbackUrl } from '../../network/p2p/loopback-url';
import { safeStringify } from '../../protocol/serialization';
import { ERC20Mock__factory } from '../../../jurisdictions/typechain-types/factories/ERC20Mock__factory';
import { Depository__factory } from '../../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { deriveRuntimeSignerPrivateKey } from '../../storage/recovery/bundle/seed-identity';
import type { PocUser } from './user';
import { collectUserReceipts } from './evidence';
import { readCanonicalChainPoint } from '../../jurisdiction/adapter/stack-manager/receipts';
import { verifyHubCommit } from './hub-proof';

import { dbRootPath } from '../../runtime/replica/platform';

const args = process.argv.slice(2);
const apiBase = readCliOption(args, '--api-base', '');
const workDir = readCliOption(args, '--work-dir', '');
const userDirectory = readCliOption(args, '--user-directory', 'poc-user');
if (!/^poc-[a-z-]+$/.test(userDirectory)) throw new Error('USDC_POC_USER_DIRECTORY_INVALID');
const directory = resolve(workDir, userDirectory);
if (!apiBase || !isLoopbackUrl(apiBase) || !workDir) throw new Error('USDC_POC_LOCAL_INPUTS_REQUIRED');
if (dbRootPath !== join(directory, 'db')) throw new Error(`USDC_POC_STORAGE_ROOT_NOT_ISOLATED:${dbRootPath}`);
const { bootUser, closeUser, requireHub, openPocAccount, userReplica } = await import('./user');
const amount = 1_000_000n;
const knownTransactions: string[] = [];

const prepareWallet = async (user: PocUser) => {
  const provider = new JsonRpcProvider(user.jurisdiction.rpc);
  if ((await provider.getNetwork()).chainId !== 31337n) throw new Error('USDC_POC_LOCAL_CHAIN_REQUIRED');
  const depository = Depository__factory.connect(user.jurisdiction.contracts.depository, provider);
  const binding = await depository._tokens(1);
  const wallet = new Wallet(deriveRuntimeSignerPrivateKey(user.seed, 0), provider);
  // The public Anvil genesis account funds the isolated fixture wallet only.
  // User ingress below still requires its own ERC20 approval and signed batch.
  const genesis = new NonceManager(
    Wallet.fromPhrase('test test test test test test test test test test test junk', provider),
  );
  const token = ERC20Mock__factory.connect(binding.contractAddress, genesis);
  if ((await token.decimals()) !== 6n) throw new Error('USDC_POC_DECIMALS_INVALID');
  await (await genesis.sendTransaction({ to: wallet.address, value: 10n ** 17n })).wait();
  const fundedReceipt = await (await token.transfer(wallet.address, amount)).wait();
  if (!fundedReceipt || fundedReceipt.status !== 1) throw new Error('USDC_POC_FIXTURE_FUNDING_FAILED');
  const userToken = token.connect(wallet);
  const funded = await provider.getBlock(fundedReceipt.blockNumber);
  if (!funded) throw new Error('USDC_POC_FUNDING_BLOCK_MISSING');
  const initialToken = await userToken.balanceOf(wallet.address, { blockTag: funded.number });
  const initialReserve = await depository._reserves(user.entityId, 1, { blockTag: funded.number });
  if (initialToken !== amount || initialReserve !== 0n) throw new Error('USDC_POC_INITIAL_BALANCE_INVALID');
  const approval = await (await userToken.approve(await depository.getAddress(), amount)).wait();
  if (!approval || approval.status !== 1) throw new Error('USDC_POC_APPROVAL_FAILED');
  knownTransactions.push(approval.hash);
  return {
    provider,
    depository,
    token: userToken,
    initialToken,
    initialReserve,
    initialBlock: funded.number,
    approval,
  };
};

const fundAccount = async (user: PocUser, hub: string) => {
  const funding = await prepareWallet(user);
  writeFileSync(
    join(directory, 'source-ingress.json'),
    safeStringify(
      {
        entityId: user.entityId,
        signerId: user.signerId,
        initialToken: funding.initialToken,
        initialReserve: funding.initialReserve,
        initialBlock: funding.initialBlock,
        approvalHash: funding.approval.hash,
        approvalBlock: funding.approval.blockNumber,
        tokenAddress: await funding.token.getAddress(),
        depositoryAddress: await funding.depository.getAddress(),
      },
      2,
    ),
  );
  const { ensureSourceCollateral } = await import('./journey/ingress');
  await ensureSourceCollateral(user, hub, await funding.token.getAddress());
  const committedAccount = userReplica(user).state.accounts.get(hub);
  if (!committedAccount) throw new Error('USDC_POC_ACCOUNT_MISSING');
  const finalBlock = await readCanonicalChainPoint(funding.provider);
  const finalToken = await funding.token.balanceOf(user.signerId, { blockTag: finalBlock.number });
  const finalReserve = await funding.depository._reserves(user.entityId, 1, { blockTag: finalBlock.number });
  if (finalToken !== 0n || finalReserve !== 0n) throw new Error('USDC_POC_FINAL_BALANCE_INVALID');
  const evidence = await collectUserReceipts(
    funding.provider,
    user.signerId,
    user.jurisdiction.contracts.depository,
    user.entityId,
    funding.approval.blockNumber,
    finalBlock.number,
  );
  funding.provider.destroy();
  return {
    initialToken: funding.initialToken,
    finalToken,
    initialReserve: funding.initialReserve,
    finalReserve,
    accountCollateral: amount,
    initialBlock: funding.initialBlock,
    finalBlock: finalBlock.number,
    ...evidence,
  };
};

const user = await bootUser(apiBase, directory);
if (args.includes('--duplicate-account-delivery')) {
  const { installDuplicateAccountDelivery } = await import('./recovery/duplicate');
  installDuplicateAccountDelivery(user);
}
const interruption = readCliOption(args, '--interrupt-point', '');
if (interruption) {
  const { installInterruption } = await import('./recovery/interrupt');
  installInterruption(user, interruption);
}
try {
  const hub = await requireHub(apiBase);
  await openPocAccount(user, apiBase, hub);
  const balances = await fundAccount(user, hub);
  const bilateral = await verifyHubCommit(user, hub, workDir);
  const report = {
    status: 'complete',
    orderId: user.orderId,
    entityId: user.entityId,
    signerId: user.signerId,
    hub,
    identities: user.identities,
    runtimeId: user.env.runtimeId,
    storageRoot: dbRootPath,
    runtimeHeight: user.env.state.height,
    balances,
    bilateral,
  };
  writeFileSync(join(directory, 'source-funding.json'), safeStringify(report, 2));
  console.log(`USDC_POC_SOURCE_FUNDED:${safeStringify(report)}`);
  if (args.includes('--cross-j-swap') || args.includes('--external-payout')) {
    const { executeCrossSwap } = await import('./cross-swap');
    const swap = await executeCrossSwap(
      user,
      hub,
      apiBase,
      workDir,
      args.includes('--partial-liquidity'),
      Number(readCliOption(args, '--expires-in-ms', '120000')),
    );
    writeFileSync(join(directory, 'cross-swap.json'), safeStringify(swap, 2));
    console.log(`USDC_POC_CROSS_SWAP:${safeStringify(swap)}`);
    if (args.includes('--external-payout')) {
      const { executeLocalPayout } = await import('./journey/local-payout');
      const { fundLocalTarget } = await import('./journey/local-funding');
      const funding = await fundLocalTarget(user, swap.targetHubEntityId, swap.grossTargetAmount, apiBase);
      const payout = { ...(await executeLocalPayout(user, hub, swap, apiBase, workDir)), funding };
      writeFileSync(join(directory, 'external-payout.json'), safeStringify(payout, 2));
      console.log(`USDC_POC_EXTERNAL_PAYOUT:${safeStringify(payout)}`);
    }
  }
} catch (error) {
  const current = [...user.env.state.eReplicas.values()].find(replica => replica.entityId === user.entityId);
  const failure = {
    status: 'failed',
    entityId: user.entityId,
    runtimeHeight: user.env.state.height,
    error: error instanceof Error ? error.message : String(error),
    knownTransactions,
    committedReserves: current?.state.reserves,
    pendingTransactionHash: current?.state.jBatchState?.sentBatch?.txHash ?? null,
  };
  writeFileSync(join(directory, 'source-funding-failure.json'), safeStringify(failure, 2));
  console.error(`USDC_POC_FAILED:${safeStringify(failure)}`);
  throw error;
} finally {
  await closeUser(user);
}
