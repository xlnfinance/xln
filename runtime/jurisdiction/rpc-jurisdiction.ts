/**
 * RpcJurisdiction - Real blockchain jurisdiction via RPC
 *
 * Connects to mainnet/testnet via JSON-RPC provider.
 * Used for production - real gas, real state, real money.
 */

import { JsonRpcProvider, Wallet, Contract, parseUnits } from 'ethers';
import type {
  IJurisdiction,
  JurisdictionConfig,
  Token,
  EntityInfo,
  TxReceipt,
} from './interface.js';

// Minimal ABIs for Depository and EntityProvider
const DEPOSITORY_ABI = [
  'function getReserves(bytes32 entity, uint256 tokenId) view returns (uint256)',
  'function getCollateral(bytes32 entity1, bytes32 entity2, uint256 tokenId) view returns (uint256)',
  'function deposit(bytes32 entityId, address token, uint256 amount)',
  'function withdraw(bytes32 entityId, address token, uint256 amount)',
  'function tokens(uint256 id) view returns (address)',
  'function tokenCount() view returns (uint256)',
] as const;

const ENTITY_PROVIDER_ABI = [
  'function getEntityInfo(bytes32 entityId) view returns (bool exists, bytes32 currentBoardHash, bytes32 proposedBoardHash, uint256 registrationBlock, string name)',
  'function registerEntity(bytes32 entityId, address[] validators, uint256 threshold)',
] as const;

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

export class RpcJurisdiction implements IJurisdiction {
  readonly type = 'rpc' as const;
  readonly chainId: number;
  readonly depositoryAddress: string;
  readonly entityProviderAddress: string;

  private provider: JsonRpcProvider;
  private depository: Contract;
  private entityProvider: Contract;
  private _ready = false;
  private _tokens: Token[] = [];

  constructor(config: JurisdictionConfig) {
    if (!config.rpcUrl) throw new Error('rpcUrl required for RPC jurisdiction');
    if (!config.depositoryAddress) throw new Error('depositoryAddress required for RPC jurisdiction');
    if (!config.entityProviderAddress) throw new Error('entityProviderAddress required for RPC jurisdiction');

    this.chainId = config.chainId;
    this.depositoryAddress = config.depositoryAddress;
    this.entityProviderAddress = config.entityProviderAddress;

    this.provider = new JsonRpcProvider(config.rpcUrl);
    this.depository = new Contract(this.depositoryAddress, DEPOSITORY_ABI, this.provider);
    this.entityProvider = new Contract(this.entityProviderAddress, ENTITY_PROVIDER_ABI, this.provider);
  }

  async init(): Promise<void> {
    if (this._ready) return;

    // Verify connection
    const network = await this.provider.getNetwork();
    if (Number(network.chainId) !== this.chainId) {
      throw new Error(`Chain ID mismatch: expected ${this.chainId}, got ${network.chainId}`);
    }

    // Load token registry
    await this.loadTokens();

    this._ready = true;
    console.log(`[RpcJurisdiction] Connected: chainId=${this.chainId}, depository=${this.depositoryAddress.slice(0, 10)}...`);
  }

  isReady(): boolean {
    return this._ready;
  }

  private async loadTokens(): Promise<void> {
    try {
      const count = await this.depository.getFunction('tokenCount')();
      this._tokens = [];

      for (let id = 1; id <= Number(count); id++) {
        const address = await this.depository.getFunction('tokens')(id);
        if (address && address !== '0x0000000000000000000000000000000000000000') {
          const token = new Contract(address, ERC20_ABI, this.provider);
          const [symbol, decimals] = await Promise.all([
            token.getFunction('symbol')().catch(() => `TOKEN${id}`),
            token.getFunction('decimals')().catch(() => 18),
          ]);
          this._tokens.push({ id, address, symbol, decimals: Number(decimals) });
        }
      }
    } catch (err) {
      console.warn('[RpcJurisdiction] Failed to load tokens:', err);
    }
  }

  // === READ OPERATIONS ===

  async getReserves(entityId: string, tokenId: number): Promise<bigint> {
    return this.depository.getFunction('getReserves')(entityId, tokenId);
  }

  async getTokens(): Promise<Token[]> {
    return this._tokens;
  }

  async getEntityInfo(entityId: string): Promise<EntityInfo | null> {
    try {
      const result = await this.entityProvider.getFunction('getEntityInfo')(entityId);
      const [exists, currentBoardHash, proposedBoardHash, registrationBlock, name] = result;

      if (!exists) return null;

      // EntityProvider returns boardHash, not decoded validators/threshold
      // To get validators/threshold we'd need to decode the board
      // For now return null - this is mainly for verification
      return null;
    } catch {
      return null;
    }
  }

  async getCollateral(entityId: string, counterpartyId: string, tokenId: number): Promise<bigint> {
    return this.depository.getFunction('getCollateral')(entityId, counterpartyId, tokenId);
  }

  // === WRITE OPERATIONS ===

  async deposit(
    signerPrivateKey: string,
    entityId: string,
    tokenId: number,
    amount: bigint
  ): Promise<TxReceipt> {
    const wallet = new Wallet(signerPrivateKey, this.provider);
    const token = this._tokens.find(t => t.id === tokenId);
    if (!token) throw new Error(`Token ${tokenId} not found`);

    // Approve
    const tokenContract = new Contract(token.address, ERC20_ABI, wallet);
    const approveTx = await tokenContract.getFunction('approve')(this.depositoryAddress, amount);
    await approveTx.wait();

    // Deposit
    const depositoryWithSigner = this.depository.connect(wallet) as Contract;
    const depositTx = await depositoryWithSigner.getFunction('deposit')(entityId, token.address, amount);
    const receipt = await depositTx.wait();

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      success: receipt.status === 1,
    };
  }

  async withdraw(
    signerPrivateKey: string,
    entityId: string,
    tokenId: number,
    amount: bigint
  ): Promise<TxReceipt> {
    const wallet = new Wallet(signerPrivateKey, this.provider);
    const token = this._tokens.find(t => t.id === tokenId);
    if (!token) throw new Error(`Token ${tokenId} not found`);

    const depositoryWithSigner = this.depository.connect(wallet) as Contract;
    const withdrawTx = await depositoryWithSigner.getFunction('withdraw')(entityId, token.address, amount);
    const receipt = await withdrawTx.wait();

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      success: receipt.status === 1,
    };
  }

  async registerEntity(
    signerPrivateKey: string,
    entityId: string,
    validators: string[],
    threshold: bigint
  ): Promise<TxReceipt> {
    const wallet = new Wallet(signerPrivateKey, this.provider);
    const entityProviderWithSigner = this.entityProvider.connect(wallet) as Contract;
    const tx = await entityProviderWithSigner.getFunction('registerEntity')(entityId, validators, threshold);
    const receipt = await tx.wait();

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      success: receipt.status === 1,
    };
  }

  // === DEBUG OPERATIONS (not available on mainnet) ===

  async debugFundReserves(_entityId: string, _tokenId: number, _amount: bigint): Promise<void> {
    throw new Error('debugFundReserves not available on RPC jurisdiction (mainnet). Use deposit() instead.');
  }

  async debugFundWallet(_address: string, _amount: bigint): Promise<void> {
    throw new Error('debugFundWallet not available on RPC jurisdiction (mainnet). Fund via external wallet.');
  }

  // === UTILITIES ===

  /** Get underlying ethers provider (for advanced use) */
  getProvider(): JsonRpcProvider {
    return this.provider;
  }
}
