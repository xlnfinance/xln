import { keccak256, type JsonRpcProvider } from 'ethers';

/** Read actual receipts and deployed code; gas lower bounds are not deployment evidence. */
export async function readDeploymentEvidence(providers: readonly JsonRpcProvider[], height: number, gasLimit: number) {
  const receipts = [];
  for (let number = 1; number <= height; number += 1) {
    const block = await providers[0].getBlock(number);
    if (!block || block.gasLimit !== BigInt(gasLimit)) throw new Error(`XLNC_DEPLOY_BLOCK_INVALID:${number}`);
    for (const hash of block.transactions) {
      const receipt = await providers[0].getTransactionReceipt(hash);
      if (!receipt || receipt.status !== 1 || receipt.gasUsed > BigInt(gasLimit))
        throw new Error(`XLNC_DEPLOY_RECEIPT_INVALID:${hash}`);
      const address = receipt.contractAddress;
      let codeHash: string | null = null;
      if (address) {
        const codes = await Promise.all(providers.map(provider => provider.getCode(address, height)));
        if (codes[0] === '0x' || codes.some(code => code !== codes[0]))
          throw new Error(`XLNC_DEPLOY_CODE_MISMATCH:${address}`);
        codeHash = keccak256(codes[0]);
      }
      receipts.push({ hash, blockNumber: number, gasUsed: receipt.gasUsed.toString(), address, codeHash });
    }
  }
  if (receipts.filter(receipt => receipt.address !== null).length !== 8)
    throw new Error('XLNC_DEPLOYMENT_EXPECTS_EIGHT_CONTRACTS');
  return receipts;
}
