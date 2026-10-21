import { TronWeb } from 'tronweb';
import { keccak256 } from 'ethers';
import wtrx from '../../../jurisdictions/external/wtrx.json';
import { parseTronAccountBalance } from '../../../core/jurisdiction/adapter/rpc/wallet/tron-wallet-snapshot';
import { safeStringify } from '../../../core/protocol/serialization';

const exactBalance = async (tronWeb: TronWeb, address: string): Promise<bigint> => {
  const hex = tronWeb.address.toHex(address);
  const response = await fetch(`${tronWeb.solidityNode.host}/walletsolidity/getaccount`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: hex }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`NATIVE_WRAPPED_ACCOUNT_HTTP:${response.status}`);
  return parseTronAccountBalance(await response.text(), `0x${hex.slice(2)}`);
};

export const nativeWrappedRoundtrip = async (tronWeb: TronWeb, data: string) => {
  const { deployTronContract } = await import('../../../jurisdictions/scripts/deploy-chain-matrix.cjs');
  const wrapped = await deployTronContract(tronWeb, 'WTRX');
  if (wrapped.runtimeCodeHash !== keccak256(wtrx.deployedBytecode)) throw new Error('NATIVE_WRAPPED_CODE_MISMATCH');
  const contract = await tronWeb.contract().at(wrapped.base58);
  const owner = tronWeb.defaultAddress.base58;
  if (!owner) throw new Error('NATIVE_WRAPPED_OWNER_MISSING');
  const feeLimit = Number(process.env['TRON_FEE_LIMIT']);
  const options = { feeLimit, shouldPollResponse: true, rawResponse: true } as const;
  const depositedAmount = 2_000_000n;
  const withdrawnAmount = 1_000_000n;
  const before = await exactBalance(tronWeb, owner);
  const deposited = await contract.deposit().send({ ...options, callValue: Number(depositedAmount) });
  // Native protobuf omits a zero fee. The witness's rewards accrue to allowance,
  // not spendable balance; no reward withdrawal or other sender tx occurs here.
  const depositFee = deposited.fee ?? 0;
  if (deposited.receipt?.result !== 'SUCCESS' || !Number.isSafeInteger(depositFee))
    throw new Error('NATIVE_WRAPPED_DEPOSIT_FAILED');
  const afterDeposit = await exactBalance(tronWeb, owner);
  if (
    afterDeposit !== before - depositedAmount - BigInt(depositFee) ||
    (await exactBalance(tronWeb, wrapped.base58)) !== depositedAmount ||
    BigInt((await contract.balanceOf(owner).call()).toString()) !== depositedAmount ||
    BigInt((await contract.totalSupply().call()).toString()) !== depositedAmount
  ) {
    throw new Error('NATIVE_WRAPPED_DEPOSIT_BALANCE_MISMATCH');
  }
  const withdrawn = await contract.withdraw(withdrawnAmount.toString()).send(options);
  const withdrawalFee = withdrawn.fee ?? 0;
  if (withdrawn.receipt?.result !== 'SUCCESS' || !Number.isSafeInteger(withdrawalFee))
    throw new Error('NATIVE_WRAPPED_WITHDRAWAL_FAILED');
  const afterWithdrawal = await exactBalance(tronWeb, owner);
  const retained = depositedAmount - withdrawnAmount;
  if (
    afterWithdrawal !== afterDeposit + withdrawnAmount - BigInt(withdrawalFee) ||
    (await exactBalance(tronWeb, wrapped.base58)) !== retained ||
    BigInt((await contract.balanceOf(owner).call()).toString()) !== retained ||
    BigInt((await contract.totalSupply().call()).toString()) !== retained
  ) {
    throw new Error('NATIVE_WRAPPED_WITHDRAWAL_BALANCE_MISMATCH');
  }
  const proof = {
    wrapped,
    before,
    afterDeposit,
    afterWithdrawal,
    depositedAmount,
    withdrawnAmount,
    retained,
    deposit: deposited,
    withdrawal: withdrawn,
  };
  await Bun.write(`${data}/wrapped.json`, safeStringify(proof, 2));
  console.log('NATIVE_WRAPPED_ROUNDTRIP', safeStringify(proof));
  return wrapped;
};
