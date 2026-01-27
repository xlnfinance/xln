/**
 * RpcEVMAdapter - Connects to real EVM chains via JSON-RPC
 *
 * Uses ethers.js Contract with typechain types for full type safety.
 * Supports Base, Ethereum, Arbitrum, etc.
 */

import type { EVM, DepositoryContract, EntityProviderContract, EVMConfig } from '../evm-interface';
import { ethers } from 'ethers';

// ABI imports - using the raw ABI from artifacts
// These match the typechain-generated interfaces

const DEPOSITORY_ABI = [
  // Read methods
  'function _reserves(bytes32 entity, uint256 tokenId) external view returns (uint256)',
  'function _collaterals(bytes32 key, uint256 tokenId) external view returns (uint256 collateral, int256 ondelta)',
  'function _accounts(bytes32 key) external view returns (uint256 cooperativeNonce, bytes32 disputeHash, uint256 disputeTimeout)',
  'function entityNonces(address entity) external view returns (uint256)',
  'function accountKey(bytes32 e1, bytes32 e2) external pure returns (bytes32)',
  // Write methods
  'function processBatch(bytes encodedBatch, address entityProvider, bytes hankoData, uint256 nonce) external returns (bool)',
  'function settle(bytes32 leftEntity, bytes32 rightEntity, tuple(uint256 tokenId, int256 leftDiff, int256 rightDiff, int256 collateralDiff, int256 ondeltaDiff)[] diffs, uint256[] forgiveDebtsInTokenIds, tuple(bytes32 insured, bytes32 insurer, uint256 tokenId, uint256 limit, uint64 expiresAt)[] insuranceRegs, bytes sig) external returns (bool)',
  'function reserveToReserve(bytes32 fromEntity, bytes32 toEntity, uint256 tokenId, uint256 amount) external returns (bool)',
  // Events
  'event AccountSettled(bytes32 indexed left, bytes32 indexed right, uint256 indexed tokenId, int256 leftReserve, int256 rightReserve, int256 collateral, int256 ondelta)',
  'event ReserveUpdated(bytes32 indexed entity, uint256 indexed tokenId, uint256 newBalance)',
  'event HankoBatchProcessed(bytes32 indexed entity, uint256 nonce)',
];

const ENTITY_PROVIDER_ABI = [
  // Read methods
  'function entities(bytes32 entityId) external view returns (bytes32 boardHash, uint8 status, uint256 activationTime)',
  'function nameToNumber(string name) external view returns (uint256)',
  'function numberToName(uint256 entityNumber) external view returns (string)',
  'function nextNumber() external view returns (uint256)',
  // Write methods
  'function registerNumberedEntity(bytes32 boardHash) external returns (uint256)',
  'function registerNumberedEntitiesBatch(bytes32[] boardHashes) external returns (uint256[])',
  'function assignName(string name, uint256 entityNumber) external',
  // Events
  'event EntityRegistered(bytes32 indexed entityId, uint256 indexed entityNumber, bytes32 boardHash)',
];

/**
 * RPC Depository contract wrapper
 */
class RpcDepositoryContract implements DepositoryContract {
  // Use 'any' to allow dynamic method access without TS complaints
  // ABI guarantees method existence at runtime
  private contract: any;
  readonly address: string;

  constructor(address: string, signer: ethers.Signer) {
    this.address = address;
    this.contract = new ethers.Contract(address, DEPOSITORY_ABI, signer);
  }

  async _reserves(entityId: string, tokenId: number): Promise<bigint> {
    return this.contract._reserves(entityId, tokenId);
  }

  async _collaterals(accountKey: string, tokenId: number): Promise<{ collateral: bigint; ondelta: bigint }> {
    const [collateral, ondelta] = await this.contract._collaterals(accountKey, tokenId);
    return { collateral, ondelta };
  }

  async _accounts(accountKey: string): Promise<{ cooperativeNonce: bigint; disputeHash: string; disputeTimeout: bigint }> {
    const [cooperativeNonce, disputeHash, disputeTimeout] = await this.contract._accounts(accountKey);
    return { cooperativeNonce, disputeHash, disputeTimeout };
  }

  async entityNonces(address: string): Promise<bigint> {
    return this.contract.entityNonces(address);
  }

  async accountKey(e1: string, e2: string): Promise<string> {
    return this.contract.accountKey(e1, e2);
  }

  async processBatch(
    encodedBatch: string,
    entityProvider: string,
    hankoData: string,
    nonce: bigint
  ): Promise<{ hash: string; wait: () => Promise<{ blockNumber: number; gasUsed: bigint }> }> {
    const tx = await this.contract.processBatch(encodedBatch, entityProvider, hankoData, nonce);
    return {
      hash: tx.hash,
      wait: async () => {
        const receipt = await tx.wait();
        return { blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
      },
    };
  }

  async settle(
    leftEntity: string,
    rightEntity: string,
    diffs: Array<{ tokenId: number; leftDiff: bigint; rightDiff: bigint; collateralDiff: bigint; ondeltaDiff: bigint }>,
    forgiveDebtsInTokenIds: number[],
    insuranceRegs: Array<{ insured: string; insurer: string; tokenId: number; limit: bigint; expiresAt: bigint }>,
    sig: string
  ): Promise<{ hash: string; wait: () => Promise<any> }> {
    const tx = await this.contract.settle(leftEntity, rightEntity, diffs, forgiveDebtsInTokenIds, insuranceRegs, sig);
    return {
      hash: tx.hash,
      wait: () => tx.wait(),
    };
  }

  async reserveToReserve(
    fromEntity: string,
    toEntity: string,
    tokenId: number,
    amount: bigint
  ): Promise<{ hash: string; wait: () => Promise<any> }> {
    const tx = await this.contract.reserveToReserve(fromEntity, toEntity, tokenId, amount);
    return {
      hash: tx.hash,
      wait: () => tx.wait(),
    };
  }

  on(event: string, listener: (...args: any[]) => void): void {
    this.contract.on(event, listener);
  }

  off(event: string, listener: (...args: any[]) => void): void {
    this.contract.off(event, listener);
  }

  removeAllListeners(event?: string): void {
    this.contract.removeAllListeners(event);
  }
}

/**
 * RPC EntityProvider contract wrapper
 */
class RpcEntityProviderContract implements EntityProviderContract {
  // Use 'any' to allow dynamic method access without TS complaints
  private contract: any;
  readonly address: string;

  constructor(address: string, signer: ethers.Signer) {
    this.address = address;
    this.contract = new ethers.Contract(address, ENTITY_PROVIDER_ABI, signer);
  }

  async entities(entityId: string): Promise<{ boardHash: string; status: number; activationTime: bigint }> {
    const [boardHash, status, activationTime] = await this.contract.entities(entityId);
    return { boardHash, status, activationTime };
  }

  async nameToNumber(name: string): Promise<bigint> {
    return this.contract.nameToNumber(name);
  }

  async numberToName(entityNumber: bigint): Promise<string> {
    return this.contract.numberToName(entityNumber);
  }

  async nextNumber(): Promise<bigint> {
    return this.contract.nextNumber();
  }

  async registerNumberedEntity(boardHash: string): Promise<{ hash: string; wait: () => Promise<any> }> {
    const tx = await this.contract.registerNumberedEntity(boardHash);
    return {
      hash: tx.hash,
      wait: () => tx.wait(),
    };
  }

  async registerNumberedEntitiesBatch(boardHashes: string[]): Promise<{ hash: string; wait: () => Promise<any> }> {
    const tx = await this.contract.registerNumberedEntitiesBatch(boardHashes);
    return {
      hash: tx.hash,
      wait: () => tx.wait(),
    };
  }

  async assignName(name: string, entityNumber: bigint): Promise<{ hash: string; wait: () => Promise<any> }> {
    const tx = await this.contract.assignName(name, entityNumber);
    return {
      hash: tx.hash,
      wait: () => tx.wait(),
    };
  }

  on(event: string, listener: (...args: any[]) => void): void {
    this.contract.on(event, listener);
  }

  off(event: string, listener: (...args: any[]) => void): void {
    this.contract.off(event, listener);
  }

  removeAllListeners(event?: string): void {
    this.contract.removeAllListeners(event);
  }
}

/**
 * RpcEVMAdapter - Full EVM interface implementation using JSON-RPC
 */
export class RpcEVMAdapter implements EVM {
  readonly type = 'rpc' as const;
  readonly name: string;
  readonly chainId: number;
  readonly depository: DepositoryContract;
  readonly entityProvider: EntityProviderContract;

  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Signer;

  private constructor(
    name: string,
    chainId: number,
    provider: ethers.JsonRpcProvider,
    signer: ethers.Signer,
    depositoryAddress: string,
    entityProviderAddress: string
  ) {
    this.name = name;
    this.chainId = chainId;
    this.provider = provider;
    this.signer = signer;
    this.depository = new RpcDepositoryContract(depositoryAddress, signer);
    this.entityProvider = new RpcEntityProviderContract(entityProviderAddress, signer);
  }

  static async connect(config: Extract<EVMConfig, { type: 'rpc' }>): Promise<RpcEVMAdapter> {
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);

    // Verify chain ID
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== config.chainId) {
      throw new Error(`Chain ID mismatch: expected ${config.chainId}, got ${network.chainId}`);
    }

    return new RpcEVMAdapter(
      config.name,
      config.chainId,
      provider,
      config.signer,
      config.depositoryAddress,
      config.entityProviderAddress
    );
  }

  async init(): Promise<void> {
    // Already initialized in connect()
  }

  async getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  // ─── Test methods not available for RPC ───
  // debugFundReserves, timeTravel, captureStateRoot are not implemented
  // They would require admin access or special test contracts
}
