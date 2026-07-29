/**
 * BrowserVM Ethers Provider
 * Wraps BrowserVM to provide ethers.js-compatible RPC interface
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import { ethers } from 'ethers';
import { createAddressFromString } from '@ethereumjs/util';
import type { BrowserVmEthersProviderTarget } from './types';

const buildBrowserVmReceipt = (
  browserVM: BrowserVmEthersProviderTarget,
  hash: string,
): Record<string, unknown> | null => {
  const receipt = browserVM.getTransactionReceipt?.(hash);
  if (!receipt) return null;
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
    logs: receipt.logs.map((log, index) => ({
      transactionIndex: 0,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      address: log.address,
      topics: log.topics,
      data: log.data,
      logIndex: index,
      blockHash: receipt.blockHash,
      removed: false,
    })),
  };
};

const buildBrowserVmBlock = (browserVM: BrowserVmEthersProviderTarget): Record<string, unknown> => {
  const zeroHash = `0x${'0'.repeat(64)}`;
  return {
    hash: browserVM.getBlockHash?.() ?? zeroHash,
    parentHash: zeroHash,
    number: Number(browserVM.getBlockNumber?.() ?? 0),
    timestamp: Math.floor((browserVM.getBlockTimestamp?.() ?? 0) / 1000),
    nonce: '0x0000000000000000',
    difficulty: 0n,
    gasLimit: 30000000n,
    gasUsed: 0n,
    miner: '0x0000000000000000000000000000000000000000',
    extraData: '0x',
    baseFeePerGas: 1n,
    transactions: [],
  };
};

export class BrowserVMEthersProvider extends ethers.AbstractProvider {
  private browserVM: BrowserVmEthersProviderTarget;
  private _network: ethers.Network;

  constructor(browserVM: unknown) {
    // cacheTimeout: -1 disables ethers' 250ms response cache. That cache exists to spare a
    // remote node duplicate requests; here the "node" is an in-memory VM one call away, so
    // it buys nothing and lies: mine a block and read the height back inside the window and
    // ethers answers with the pre-mine number. Chain reads must reflect the chain.
    super(undefined, { cacheTimeout: -1 });
    this.browserVM = browserVM as BrowserVmEthersProviderTarget;
    const chainId = this.browserVM.getChainId?.() ?? 31337;
    this._network = new ethers.Network('browservm', chainId);
  }

  override async _detectNetwork(): Promise<ethers.Network> {
    return this._network;
  }

  async send(method: string, params: unknown[]): Promise<unknown> {
    if (method !== 'evm_mine') {
      throw new Error(`BROWSERVM_RPC_METHOD_UNSUPPORTED:${method}`);
    }
    if (params.length !== 0) {
      throw new Error(`BROWSERVM_EVM_MINE_PARAMS_UNSUPPORTED:${params.length}`);
    }
    if (typeof this.browserVM.mineEmptyBlock !== 'function') {
      throw new Error('BROWSERVM_EMPTY_BLOCK_MINING_UNAVAILABLE');
    }
    await this.browserVM.mineEmptyBlock();
    return '0x0';
  }

  private async runReadOnlyCall(
    request: Parameters<BrowserVmEthersProviderTarget['vm']['evm']['runCall']>[0],
  ): ReturnType<BrowserVmEthersProviderTarget['vm']['evm']['runCall']> {
    return this.browserVM.runExclusiveVmOperation(async () => {
      const stateManager = this.browserVM.vm.stateManager;
      await stateManager.checkpoint();
      let result: Awaited<ReturnType<BrowserVmEthersProviderTarget['vm']['evm']['runCall']>> | undefined;
      let primaryError: unknown;
      try {
        result = await this.browserVM.vm.evm.runCall(request);
      } catch (error) {
        primaryError = error;
      }
      try {
        await stateManager.revert();
      } catch (revertError) {
        if (primaryError !== undefined) {
          throw new AggregateError([primaryError, revertError], 'BROWSERVM_READ_CALL_AND_REVERT_FAILED');
        }
        throw revertError;
      }
      if (primaryError !== undefined) throw primaryError;
      if (!result) throw new Error('BROWSERVM_READ_CALL_RESULT_MISSING');
      return result;
    });
  }

  override async _perform<T = unknown>(req: ethers.PerformActionRequest): Promise<T> {
    const asResponse = (value: unknown): T => value as T;
    if (String(req.method) === 'getFeeData') {
      return asResponse({
        gasPrice: 1000000000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });
    }
    switch (req.method) {
      case 'chainId':
        return asResponse(this.browserVM.getChainId?.() ?? 31337);

      case 'getBlockNumber':
        return asResponse(Number(this.browserVM.getBlockNumber?.() ?? 0));

      case 'getGasPrice':
        return asResponse(1000000000n); // 1 gwei

      case 'getPriorityFee':
        return asResponse(1000000000n); // 1 gwei

      case 'getTransactionCount': {
        const txCountAccount = await this.browserVM.runExclusiveVmOperation(() =>
          this.browserVM.vm.stateManager.getAccount(createAddressFromString(ethers.getAddress(req.address))),
        );
        return asResponse(Number(txCountAccount?.nonce || 0n));
      }

      case 'getBalance': {
        const account = await this.browserVM.runExclusiveVmOperation(() =>
          this.browserVM.vm.stateManager.getAccount(createAddressFromString(ethers.getAddress(req.address))),
        );
        return asResponse(account?.balance || 0n);
      }

      case 'getCode': {
        const code = await this.browserVM.runExclusiveVmOperation(() =>
          this.browserVM.vm.stateManager.getCode(createAddressFromString(ethers.getAddress(req.address))),
        );
        return asResponse(ethers.hexlify(code));
      }

      case 'call': {
        const result = await this.runReadOnlyCall({
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

        return asResponse(ethers.hexlify(result.execResult.returnValue));
      }

      case 'broadcastTransaction': {
        // Execute state-changing transaction via browserVM
        const txHash = await this.browserVM.executeSignedTx(req.signedTransaction);
        return asResponse(txHash);
      }

      case 'getTransactionReceipt': {
        return asResponse(buildBrowserVmReceipt(this.browserVM, req.hash));
      }

      case 'getTransaction':
        // BrowserVM doesn't store full tx data
        return asResponse(null);

      case 'estimateGas': {
        if (!req.transaction.to) {
          throw new Error('BROWSERVM_ESTIMATE_GAS_CONTRACT_CREATION_UNSUPPORTED');
        }
        const data = ethers.getBytes(req.transaction.data || '0x');
        const result = await this.runReadOnlyCall({
          to: createAddressFromString(ethers.getAddress(req.transaction.to)),
          caller: req.transaction.from
            ? createAddressFromString(ethers.getAddress(req.transaction.from))
            : this.browserVM.deployerAddress,
          data,
          gasLimit: 30_000_000n,
          value: req.transaction.value ?? 0n,
        });
        if (result.execResult.exceptionError) {
          throw new Error(`BROWSERVM_ESTIMATE_GAS_FAILED:${String(result.execResult.exceptionError)}`);
        }
        const zeroBytes = data.reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0);
        const intrinsicGas = 21_000n + BigInt(zeroBytes * 4 + (data.length - zeroBytes) * 16);
        const measured = result.execResult.executionGasUsed + intrinsicGas;
        return asResponse((measured * 120n) / 100n + 10_000n);
      }

      case 'getBlock': {
        return asResponse(buildBrowserVmBlock(this.browserVM));
      }

      case 'getLogs': {
        return asResponse(this.browserVM.getLogs?.(req.filter) ?? []);
      }

      default:
        throw new Error(`Unsupported method: ${req.method}`);
    }
  }
}
