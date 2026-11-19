import { JsonRpcProvider } from 'ethers';
import { ERC20Mock__factory } from '../../../jurisdictions/typechain-types/factories/ERC20Mock__factory';
import { Depository__factory } from '../../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { computeAccountKey } from '../../jurisdiction/adapter/events/contract-codec';
import { readCanonicalChainPoint } from '../../jurisdiction/adapter/stack-manager/receipts';
import { deriveDelta, isLeftEntity } from '../../account/utils';
import { userReplica, type PocUser } from './user';
import { receiptFields, type MinedReceipt } from './evidence';

export const targetContracts = async (user: PocUser, rpc = user.jurisdiction.rpc) => {
  const provider = new JsonRpcProvider(rpc);
  if ((await provider.getNetwork()).chainId !== BigInt(user.jurisdiction.chainId))
    throw new Error('USDC_POC_TARGET_CHAIN_MISMATCH');
  const depository = Depository__factory.connect(user.jurisdiction.contracts.depository, provider);
  const binding = await depository._tokens(1);
  const token = ERC20Mock__factory.connect(binding.contractAddress, provider);
  if ((await token.decimals()) !== 6n) throw new Error('USDC_POC_TARGET_DECIMALS_INVALID');
  return { provider, depository, token };
};

export type TargetContracts = Awaited<ReturnType<typeof targetContracts>>;

export const targetSnapshot = async (user: PocUser, hub: string, contracts: TargetContracts) => {
  const block = await readCanonicalChainPoint(contracts.provider);
  const at = { blockTag: block.number };
  const account = userReplica(user).state.accounts.get(hub);
  const delta = account?.state.deltas.get(1);
  if (!account || !delta) throw new Error('USDC_POC_TARGET_ACCOUNT_MISSING');
  return {
    block,
    token: await contracts.token.balanceOf(user.signerId, at),
    depositoryTokens: await contracts.token.balanceOf(await contracts.depository.getAddress(), at),
    reserve: await contracts.depository._reserves(user.entityId, 1, at),
    hubReserve: await contracts.depository._reserves(hub, 1, at),
    activeDebts: await contracts.depository.activeDebts(user.entityId, at),
    hubActiveDebts: await contracts.depository.activeDebts(hub, at),
    collateral: (await contracts.depository._collaterals(computeAccountKey(user.entityId, hub), 1, at)).collateral,
    account: {
      height: account.currentHeight,
      stateHash: account.currentFrame.stateHash,
      view: deriveDelta(delta, isLeftEntity(user.entityId, hub)),
    },
  };
};

/** Read only receipts for the selected Entities, including an explicit fixture sponsor when requested. */
export const targetReceipts = async (
  contracts: TargetContracts,
  firstBlock: number,
  lastBlock: number,
  entityIds: readonly string[],
  approvalHashes: readonly string[] = [],
) => {
  const event = contracts.depository.interface.getEvent('HankoBatchProcessed');
  const logs = await contracts.provider.getLogs({
    address: await contracts.depository.getAddress(),
    fromBlock: firstBlock,
    toBlock: lastBlock,
    topics: [event.topicHash, [...entityIds]],
  });
  const entries: MinedReceipt[] = [];
  for (const hash of new Set([...approvalHashes, ...logs.map(log => log.transactionHash)])) {
    const tx = await contracts.provider.getTransaction(hash);
    const receipt = await contracts.provider.getTransactionReceipt(hash);
    if (!tx || !receipt || receipt.status !== 1 || receipt.blockNumber < firstBlock || receipt.blockNumber > lastBlock)
      throw new Error(`USDC_POC_TARGET_RECEIPT_FAILED:${hash}`);
    const block = await contracts.provider.getBlock(receipt.blockNumber);
    if (!block || block.hash !== receipt.blockHash) throw new Error(`USDC_POC_TARGET_RECEIPT_REORG:${hash}`);
    entries.push({ transaction: tx, receipt });
  }
  return buildTargetReceiptEvidence(contracts.provider, entries, firstBlock, lastBlock);
};

export const buildTargetReceiptEvidence = async (
  provider: JsonRpcProvider,
  entries: readonly MinedReceipt[],
  firstBlock: number,
  lastBlock: number,
) => {
  const receipts = entries.map(entry => ({
    ...receiptFields(entry),
    to: entry.transaction.to?.toLowerCase() ?? null,
    value: entry.transaction.value,
  }));
  const native = [];
  for (const payer of new Set(receipts.map(receipt => receipt.payer))) {
    const initial = await provider.getBalance(payer, firstBlock - 1);
    const final = await provider.getBalance(payer, lastBlock);
    const fees = receipts.filter(receipt => receipt.payer === payer).reduce((n, receipt) => n + receipt.fee, 0n);
    const sent = receipts.filter(receipt => receipt.payer === payer).reduce((n, receipt) => n + receipt.value, 0n);
    const received = receipts.filter(receipt => receipt.to === payer).reduce((n, receipt) => n + receipt.value, 0n);
    if (initial + received - final - sent !== fees) throw new Error(`USDC_POC_TARGET_NATIVE_MISMATCH:${payer}`);
    native.push({ payer, initial, final, sent, received, fees, unaccounted: 0n });
  }
  return { chainId: Number((await provider.getNetwork()).chainId), receipts, native };
};

type ReceiptEvidence = { receipts: readonly ReturnType<typeof receiptFields>[] };

const tokenInterface = ERC20Mock__factory.createInterface();
const transferEvent = tokenInterface.getEvent('Transfer');

const readTokenTransfers = (evidence: ReceiptEvidence, address: string) =>
  evidence.receipts.flatMap(receipt => {
    const transactionReceipt = receipt.receipt;
    if (
      !transactionReceipt ||
      typeof transactionReceipt !== 'object' ||
      !('logs' in transactionReceipt) ||
      !Array.isArray(transactionReceipt.logs)
    )
      throw new Error('USDC_POC_TARGET_LOGS_MISSING');
    return transactionReceipt.logs.flatMap((log: { address: string; topics: string[]; data: string }) => {
      if (log.address.toLowerCase() !== address || log.topics[0] !== transferEvent.topicHash) return [];
      const decoded = tokenInterface.parseLog(log);
      if (!decoded) throw new Error('USDC_POC_TARGET_TRANSFER_INVALID');
      return [
        {
          transactionHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          from: String(decoded.args[0]).toLowerCase(),
          to: String(decoded.args[1]).toLowerCase(),
          amount: BigInt(decoded.args[2]),
        },
      ];
    });
  });

export const requireTokenTransfer = (
  evidence: ReceiptEvidence,
  expected: { token: string; from: string; to: string; amount: bigint },
) => {
  const transfers = readTokenTransfers(evidence, expected.token.toLowerCase());
  const incoming = transfers.filter(transfer => transfer.to === expected.to.toLowerCase());
  if (
    incoming.length !== 1 ||
    incoming[0]?.from !== expected.from.toLowerCase() ||
    incoming[0].amount !== expected.amount
  )
    throw new Error('USDC_POC_TRANSFER_ATTRIBUTION_FAILED');
  return transfers;
};

export const requireWithdrawalTransfers = (
  contracts: TargetContracts,
  evidence: ReceiptEvidence,
  recipient: string,
  amount: bigint,
) =>
  requireTokenTransfer(evidence, {
    token: contracts.token.target.toString(),
    from: contracts.depository.target.toString(),
    to: recipient,
    amount,
  });
