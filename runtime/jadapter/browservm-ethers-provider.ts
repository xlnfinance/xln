/**
 * BrowserVM Ethers Provider
 * Wraps BrowserVM to provide ethers.js-compatible RPC interface
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import { ethers } from 'ethers';
import { createAddressFromString } from '@ethereumjs/util';

export class BrowserVMEthersProvider extends ethers.AbstractProvider {
  private browserVM: any;
  private _network: ethers.Network;

  constructor(browserVM: any) {
    super();
    this.browserVM = browserVM;
    const chainId = browserVM.getChainId?.() ?? 31337;
    this._network = new ethers.Network('browservm', chainId);
  }

  override async _detectNetwork(): Promise<ethers.Network> {
    return this._network;
  }

  override async _perform(req: ethers.PerformActionRequest): Promise<any> {
    switch (req.method) {
      case 'chainId':
        return this.browserVM.getChainId?.() ?? 31337;

      case 'getBlockNumber':
        return Number(this.browserVM.getBlockNumber?.() ?? 0);

      case 'getGasPrice':
        return 1000000000n; // 1 gwei

      case 'getPriorityFee':
        return 1000000000n; // 1 gwei

      // @ts-ignore - getFeeData is a valid ethers request but not in PerformActionRequest type
      case 'getFeeData':
        return {
          gasPrice: 1000000000n,
          maxFeePerGas: 1000000000n,
          maxPriorityFeePerGas: 1000000000n,
        };

      case 'getTransactionCount': {
        const txCountAccount = await this.browserVM.vm.stateManager.getAccount(
          createAddressFromString(ethers.getAddress(req.address))
        );
        return Number(txCountAccount?.nonce || 0n);
      }

      case 'getBalance': {
        const account = await this.browserVM.vm.stateManager.getAccount(
          createAddressFromString(ethers.getAddress(req.address))
        );
        return account?.balance || 0n;
      }

      case 'getCode': {
        const code = await this.browserVM.vm.stateManager.getCode(
          createAddressFromString(ethers.getAddress(req.address))
        );
        return ethers.hexlify(code);
      }

      case 'call': {
        const result = await this.browserVM.vm.evm.runCall({
          to: createAddressFromString(ethers.getAddress(req.transaction.to!)),
          caller: req.transaction.from
            ? createAddressFromString(ethers.getAddress(req.transaction.from))
            : this.browserVM.deployerAddress,
          data: ethers.getBytes(req.transaction.data || '0x'),
          gasLimit: req.transaction.gasLimit || 100000n,
        });

        if (result.execResult.exceptionError) {
          throw new Error(`Call failed: ${result.execResult.exceptionError}`);
        }

        return ethers.hexlify(result.execResult.returnValue);
      }

      case 'broadcastTransaction': {
        // Execute state-changing transaction via browserVM
        const txHash = await this.browserVM.executeSignedTx(req.signedTransaction);
        return txHash;
      }

      case 'getTransactionReceipt': {
        const receipt = this.browserVM.getTransactionReceipt?.(req.hash);
        if (!receipt) return null;

        // Convert to ethers format
        return {
          to: receipt.to,
          from: receipt.from,
          contractAddress: receipt.contractAddress,
          hash: receipt.transactionHash,
          index: 0,
          blockHash: receipt.blockHash,
          blockNumber: receipt.blockNumber,
          logsBloom: '0x',
          gasUsed: 100000n,
          cumulativeGasUsed: 100000n,
          gasPrice: 1n,
          status: receipt.status,
          type: 0,
          logs: receipt.logs.map((log: any, i: number) => ({
            transactionIndex: 0,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
            address: log.address,
            topics: log.topics,
            data: log.data,
            logIndex: i,
            blockHash: receipt.blockHash,
            removed: false,
          })),
        };
      }

      case 'getTransaction':
        // BrowserVM doesn't store full tx data
        return null;

      case 'estimateGas':
        return 1000000n;

      case 'getBlock': {
        // Return minimal block info
        const blockNumber = Number(this.browserVM.getBlockNumber?.() ?? 0);
        const zeroHash = '0x' + '0'.repeat(64);
        return {
          hash: this.browserVM.getBlockHash?.() ?? zeroHash,
          parentHash: zeroHash,
          number: blockNumber,
          timestamp: Math.floor((this.browserVM.getBlockTimestamp?.() ?? 0) / 1000),
          nonce: '0x0000000000000000',
          difficulty: 0n,
          gasLimit: 30000000n,
          gasUsed: 0n,
          miner: '0x0000000000000000000000000000000000000000',
          extraData: '0x',
          baseFeePerGas: 1n,
          transactions: [],
        };
      }

      case 'getLogs': {
        // For now return empty - logs are delivered via callbacks
        // TODO: Implement proper log storage and filtering
        return [];
      }

      default:
        throw new Error(`Unsupported method: ${req.method}`);
    }
  }
}
