import { ethers } from 'ethers';
import { normalizeEntityId } from '../../entity/id';
import type { Signer } from 'ethers';
import type { JBatch } from '../machine/batch';
import { buildExternalTokenToReserveBatch } from './contract-codec';
import type { TxOverrides } from './rpc-boundary';
import type { RpcWriteMethods, RpcWriteContext } from './rpc-write-methods';
import type { JBatchReceipt } from './types';

export const createRpcExternalDeposit = (
  context: RpcWriteContext,
  processSignedBatch: (
    entityId: string,
    batch: JBatch,
    signer: Signer,
    signingKey: string,
  ) => Promise<JBatchReceipt>,
): Pick<RpcWriteMethods, 'externalTokenToReserve'> => ({
  async externalTokenToReserve(signerPrivateKey, entityId, tokenAddress, amount, options) {
    const walletKey = `0x${Buffer.from(signerPrivateKey).toString('hex')}`;
    const wallet = await context.chainIo.signerForPrivateKey(walletKey);
    const signerAddress = await wallet.getAddress();
    const tokenType = options?.tokenType ?? 0;
    if (tokenType !== 0) throw new Error('RPC adapter externalTokenToReserve currently supports ERC20 only');
    const erc20 = new ethers.Contract(tokenAddress, [
      'function balanceOf(address owner) view returns (uint256)',
      'function approve(address spender, uint256 amount) returns (bool)',
      'function allowance(address owner, address spender) view returns (uint256)',
    ], wallet);
    const tokenCode = await context.provider.getCode(tokenAddress);
    if (!tokenCode || tokenCode === '0x') throw new Error(`ERC20 token not deployed at ${tokenAddress}`);
    const balance = await (erc20.getFunction('balanceOf') as (owner: string) => Promise<bigint>)(signerAddress);
    if (balance < amount) {
      throw new Error(`Insufficient external token balance: have ${balance}, need ${amount} at ${tokenAddress}`);
    }
    const depositoryAddress = await context.stack.getDepositoryAddress();
    const allowance = await (
      erc20.getFunction('allowance') as (owner: string, spender: string) => Promise<bigint>
    )(signerAddress, depositoryAddress);
    const approve = erc20.getFunction('approve') as (
      spender: string,
      amount: bigint,
      overrides?: TxOverrides,
    ) => Promise<unknown>;
    if (allowance < amount) {
      await context.sequencer.runFor(wallet, async () => {
        if (allowance > 0n) {
          await context.sequencer.send(wallet, 'erc20ApproveReset', (nonce, fees) =>
            approve(depositoryAddress, 0n, { ...fees, nonce }));
        }
        await context.sequencer.send(wallet, 'erc20ApproveMax', (nonce, fees) =>
          approve(depositoryAddress, ethers.MaxUint256, { ...fees, nonce }));
      });
    }
    const batch = buildExternalTokenToReserveBatch({
      entityId,
      tokenAddress,
      amount,
      tokenType,
      externalTokenId: options?.externalTokenId ?? 0n,
      internalTokenId: options?.internalTokenId ?? 0,
    });
    const receipt = await processSignedBatch(entityId, batch, wallet, walletKey);
    const normalized = normalizeEntityId(entityId);
    const processed = receipt.events.find(
      event => event.name === 'HankoBatchProcessed' && String(event.args['entityId'] || '').toLowerCase() === normalized,
    );
    if (processed?.args['success'] === false) {
      throw new Error(`externalTokenToReserve failed on-chain for ${normalized.slice(-8)}`);
    }
    if (!receipt.events.some(
      event => event.name === 'ReserveUpdated' && String(event.args['entity'] || '').toLowerCase() === normalized,
    )) {
      throw new Error(
        `externalTokenToReserve missing ReserveUpdated for ${normalized.slice(-8)} ` +
          `(events=${receipt.events.map(event => event.name).join(',') || 'none'})`,
      );
    }
    return receipt.events;
  },
});
