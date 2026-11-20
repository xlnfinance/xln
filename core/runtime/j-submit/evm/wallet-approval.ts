import { Interface, Transaction } from 'ethers';
import { requireString } from '../../../protocol/boundary/boundary-primitives';
import type { RuntimeReplica, RuntimeTx } from '../../types';

type ApprovalTx = Extract<RuntimeTx, { type: 'recordEvmWalletApproval' }>;
const localApproval = Symbol('xln.local-evm-wallet-approval');
const erc20 = new Interface(['function approve(address spender,uint256 amount) returns(bool)']);

export const decodeEvmWalletApproval = (value: unknown, code: string) => {
  const rawTransaction = requireString(value, code);
  if (!/^0x(?:[0-9a-f]{2})+$/.test(rawTransaction) || rawTransaction.length > 1024) throw new Error(`${code}_RAW`);
  const wire = Transaction.from(rawTransaction);
  const { hash, from, to, nonce } = wire;
  const chainId = Number(wire.chainId);
  if (
    !hash ||
    !from ||
    !to ||
    wire.type !== 2 ||
    wire.value !== 0n ||
    wire.gasLimit <= 0n ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !Number.isSafeInteger(nonce) ||
    nonce < 0 ||
    wire.serialized !== rawTransaction ||
    wire.accessList?.length
  )
    throw new Error(`${code}_WIRE`);
  const [spender, amount]: unknown[] = erc20.decodeFunctionData('approve', wire.data).toArray();
  if (
    typeof spender !== 'string' ||
    typeof amount !== 'bigint' ||
    erc20.encodeFunctionData('approve', [spender, amount]) !== wire.data
  )
    throw new Error(`${code}_CALL`);
  return { rawTransaction, hash, payer: from.toLowerCase(), spender: spender.toLowerCase(), chainId, nonce };
};

export const createEvmWalletApprovalTx = (rawTransaction: string): ApprovalTx => {
  const tx: ApprovalTx = { type: 'recordEvmWalletApproval', data: { rawTransaction } };
  Object.defineProperty(tx, localApproval, { value: true });
  return tx;
};

export const assertEvmWalletApprovalAuthorized = (tx: RuntimeTx, replay: boolean): void => {
  if (tx.type === 'recordEvmWalletApproval' && !replay && !Object.hasOwn(tx, localApproval))
    throw new Error('EVM_WALLET_APPROVAL_EXTERNAL_INPUT');
};

export const readEvmWalletApproval = (env: RuntimeReplica, chainId: number) => {
  const raw = env.infrastructure?.evmWalletApprovals?.get(String(chainId));
  return raw === undefined ? null : decodeEvmWalletApproval(raw, 'EVM_WALLET_APPROVAL_COMMITTED');
};

/** A Runtime records only its own signed wallet wire for a configured Depository.
 * Advancing a nonce leaves old attempts in the journal. A duplicate or older
 * nonce cannot install different bytes, including after checkpoint recovery. */
export const applyEvmWalletApproval = (env: RuntimeReplica, tx: ApprovalTx): void => {
  const approval = decodeEvmWalletApproval(tx.data.rawTransaction, 'EVM_WALLET_APPROVAL');
  const chain = [...env.state.jReplicas.values()].find(replica => replica.chainId === approval.chainId);
  if (
    env.runtimeId?.toLowerCase() !== approval.payer ||
    chain?.contracts?.depository?.toLowerCase() !== approval.spender
  )
    throw new Error('EVM_WALLET_APPROVAL_OWNER_OR_STACK_MISMATCH');
  const previous = readEvmWalletApproval(env, approval.chainId);
  if (previous && approval.nonce <= previous.nonce) {
    if (previous.rawTransaction === approval.rawTransaction) return;
    throw new Error('EVM_WALLET_APPROVAL_NONCE_ALREADY_RECORDED');
  }
  env.infrastructure ??= {};
  const approvals = new Map(env.infrastructure.evmWalletApprovals);
  approvals.set(String(approval.chainId), approval.rawTransaction);
  env.infrastructure.evmWalletApprovals = approvals;
};
