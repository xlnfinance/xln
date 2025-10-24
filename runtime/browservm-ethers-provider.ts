/**
 * BrowserVM Ethers Provider
 * Wraps BrowserVM to provide ethers.js-compatible RPC interface
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import { ethers } from 'ethers';

export class BrowserVMEthersProvider extends ethers.AbstractProvider {
  private browserVM: any;

  constructor(browserVM: any) {
    super();
    this.browserVM = browserVM;
  }

  async _perform(req: ethers.PerformActionRequest): Promise<any> {
    switch (req.method) {
      case 'chainId':
        return 1337; // BrowserVM chainId

      case 'getBlockNumber':
        return 0; // BrowserVM doesn't track blocks

      case 'getTransactionCount':
        // Get nonce for address
        const txCountAccount = await this.browserVM.vm.stateManager.getAccount(
          ethers.getAddress(req.address)
        );
        return Number(txCountAccount?.nonce || 0n);

      case 'getBalance':
        // Return balance from VM state
        const account = await this.browserVM.vm.stateManager.getAccount(
          ethers.getAddress(req.address)
        );
        return account?.balance || 0n;

      case 'getCode':
        // Get contract code from VM state
        const code = await this.browserVM.vm.stateManager.getCode(
          ethers.getAddress(req.address)
        );
        return ethers.hexlify(code);

      case 'call':
        // Execute read-only call
        const result = await this.browserVM.vm.evm.runCall({
          to: ethers.getAddress(req.transaction.to!),
          caller: req.transaction.from
            ? ethers.getAddress(req.transaction.from)
            : this.browserVM.deployerAddress,
          data: ethers.getBytes(req.transaction.data || '0x'),
          gasLimit: req.transaction.gasLimit || 100000n,
        });

        if (result.execResult.exceptionError) {
          throw new Error(`Call failed: ${result.execResult.exceptionError}`);
        }

        return ethers.hexlify(result.execResult.returnValue);

      case 'sendTransaction':
        // Execute state-changing transaction via browserVM
        return await this.browserVM.executeTx({
          to: req.signedTransaction.to as string | undefined,
          data: req.signedTransaction.data as string,
          gasLimit: req.signedTransaction.gasLimit ? BigInt(req.signedTransaction.gasLimit) : undefined,
        });

      case 'getTransaction':
      case 'getTransactionReceipt':
        // BrowserVM doesn't store tx history - return null
        return null;

      case 'estimateGas':
        // Return fixed gas estimate
        return 1000000;

      default:
        throw new Error(`Unsupported method: ${req.method}`);
    }
  }

  private async _getCurrentNonce(): Promise<bigint> {
    const account = await this.browserVM.vm.stateManager.getAccount(this.browserVM.deployerAddress);
    return account?.nonce || 0n;
  }
}
