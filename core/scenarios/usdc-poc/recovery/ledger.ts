import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonRpcProvider, isAddress, isHexString } from 'ethers';
import { Depository__factory } from '../../../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { ERC20Mock__factory } from '../../../../jurisdictions/typechain-types/factories/ERC20Mock__factory';
import { safeParse, safeStringify } from '../../../protocol/serialization';
import { requireBoundaryInteger, requireBoundaryRecord } from '../../../protocol/boundary-validation';
import { requireBigInt } from '../../../protocol/boundary/boundary-primitives';
import { readCanonicalChainPoint } from '../../../jurisdiction/adapter/stack-manager/receipts';
import { collectUserReceipts } from '../evidence';
import { requireWithdrawalTransfers, targetReceipts } from '../target-evidence';

const report = (path: string) =>
  requireBoundaryRecord(safeParse(readFileSync(path, 'utf8')), 'USDC_POC_LEDGER_REPORT_INVALID');
const address = (value: unknown): string => {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error('USDC_POC_LEDGER_ADDRESS_INVALID');
  return value;
};
const entity = (value: unknown): string => {
  if (typeof value !== 'string' || !isHexString(value, 32)) throw new Error('USDC_POC_LEDGER_ENTITY_INVALID');
  return value;
};

/** Report files identify observations; only chain receipts/balances certify effects. */
export const verifyRecoveredLedger = async (apiBase: string, directory: string) => {
  const ingress = report(join(directory, 'source-ingress.json'));
  const funding = report(join(directory, 'target-operator-funding.json'));
  const recovered = report(join(directory, 'recovered-payout.json'));
  const payout = requireBoundaryRecord(recovered['payout'], 'USDC_POC_LEDGER_PAYOUT_INVALID');
  const source = new JsonRpcProvider(`${apiBase}/rpc`);
  const targetRpc = new URL(apiBase);
  targetRpc.port = String(Number(targetRpc.port) - 3);
  const target = new JsonRpcProvider(targetRpc.toString());
  try {
    if ((await source.getNetwork()).chainId !== 31337n || (await target.getNetwork()).chainId !== 31338n)
      throw new Error('USDC_POC_LEDGER_LOCAL_CHAINS_REQUIRED');
    const sourceDepository = Depository__factory.connect(address(ingress['depositoryAddress']), source);
    const sourceToken = ERC20Mock__factory.connect(address(ingress['tokenAddress']), source);
    const sourceHead = await readCanonicalChainPoint(source);
    const sourceEntity = entity(ingress['entityId']);
    const sourceSigner = address(ingress['signerId']);
    const sourceReceipts = await collectUserReceipts(
      source,
      sourceSigner,
      address(ingress['depositoryAddress']),
      sourceEntity,
      requireBoundaryInteger(ingress['approvalBlock'], 'USDC_POC_LEDGER_APPROVAL_BLOCK'),
      sourceHead.number,
    );
    if (
      (await sourceDepository.entityNonces(sourceEntity)) !== 2n ||
      (await sourceToken.balanceOf(sourceSigner)) !== 0n ||
      (await sourceDepository._reserves(sourceEntity, 1)) !== 0n
    )
      throw new Error('USDC_POC_SOURCE_EFFECT_DUPLICATED');
    const depository = Depository__factory.connect(address(funding['depositoryAddress']), target);
    const token = ERC20Mock__factory.connect(address(funding['tokenAddress']), target);
    const targetHead = await readCanonicalChainPoint(target);
    const targetEntity = entity(payout['targetEntityId']);
    const recipient = address(payout['recipient']);
    const paid = requireBigInt(payout['paid'], 'USDC_POC_LEDGER_PAID');
    const gross = requireBigInt(payout['grossTargetAmount'], 'USDC_POC_LEDGER_GROSS');
    if (
      gross - paid !== requireBigInt(payout['fee'], 'USDC_POC_LEDGER_FEE') ||
      gross !== requireBigInt(funding['amount'], 'USDC_POC_LEDGER_OPERATOR_AMOUNT')
    )
      throw new Error('USDC_POC_RECOVERY_FEE_NOT_EXACT');
    const reserveBefore = requireBigInt(funding['reserveBefore'], 'USDC_POC_LEDGER_RESERVE_BEFORE');
    const tokenBefore = requireBigInt(funding['tokenBefore'], 'USDC_POC_LEDGER_TOKEN_BEFORE');
    const evidence = await targetReceipts(
      { provider: target, depository, token },
      requireBoundaryInteger(funding['approvalBlock'], 'USDC_POC_LEDGER_TARGET_FIRST_BLOCK'),
      targetHead.number,
      [targetEntity, entity(payout['targetHubEntityId']), entity(funding['operatorEntity'])],
      [String(funding['approvalHash'])],
    );
    const transfers = requireWithdrawalTransfers({ provider: target, depository, token }, evidence, recipient, paid);
    if (
      (await depository.entityNonces(targetEntity)) !== 1n ||
      (await token.balanceOf(recipient)) !== paid ||
      (await depository._reserves(targetEntity, 1)) !== 0n ||
      paid < 850_000n ||
      1_000_000n - paid > 150_000n ||
      (await depository._reserves(entity(payout['targetHubEntityId']), 1)) !== reserveBefore + gross - paid ||
      (await token.balanceOf(await depository.getAddress())) !== tokenBefore + gross - paid
    )
      throw new Error('USDC_POC_TARGET_EFFECT_DUPLICATED');
    const result = {
      sourceHead,
      targetHead,
      sourceEntity,
      sourceSigner,
      targetEntity,
      recipient,
      sourceAmount: 1_000_000n,
      gross,
      paid,
      feeChargedOnce: gross - paid,
      sourceEntityNonce: 2,
      targetEntityNonce: 1,
      sourceReceipts,
      target: evidence,
      transfers,
    };
    writeFileSync(join(directory, 'recovered-ledger.json'), safeStringify(result, 2));
    return result;
  } finally {
    source.destroy();
    target.destroy();
  }
};
