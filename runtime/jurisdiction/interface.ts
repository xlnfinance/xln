/**
 * IJurisdiction - Universal interface for blockchain jurisdictions
 *
 * Works identically for:
 * - BrowserVM (simnet, in-memory, instant)
 * - RPC (mainnet/testnet, real gas, real state)
 *
 * All code should use getJurisdiction() factory, never instantiate directly.
 */

export interface Token {
  id: number;
  address: string;
  symbol: string;
  decimals: number;
}

export interface EntityInfo {
  entityId: string;
  registered: boolean;
  validators: string[];
  threshold: bigint;
}

export interface TxReceipt {
  hash: string;
  blockNumber: number;
  gasUsed: bigint;
  success: boolean;
}

export interface JurisdictionConfig {
  type: 'browser' | 'rpc';
  chainId: number;
  rpcUrl?: string;  // Required for 'rpc' type
  depositoryAddress?: string;  // Optional - deploy new if not provided (browser only)
  entityProviderAddress?: string;
}

/**
 * Universal jurisdiction interface
 *
 * Implemented by BrowserJurisdiction and RpcJurisdiction
 */
export interface IJurisdiction {
  // Identity
  readonly chainId: number;
  readonly depositoryAddress: string;
  readonly entityProviderAddress: string;
  readonly type: 'browser' | 'rpc';

  // Initialization
  init(): Promise<void>;
  isReady(): boolean;

  // === READ OPERATIONS (no gas) ===

  /** Get reserve balance for entity */
  getReserves(entityId: string, tokenId: number): Promise<bigint>;

  /** Get all registered tokens */
  getTokens(): Promise<Token[]>;

  /** Get entity info from EntityProvider */
  getEntityInfo(entityId: string): Promise<EntityInfo | null>;

  /** Get collateral balance in account */
  getCollateral(entityId: string, counterpartyId: string, tokenId: number): Promise<bigint>;

  // === WRITE OPERATIONS (require signer, cost gas on mainnet) ===

  /** Deposit tokens from EOA to entity reserves */
  deposit(
    signerPrivateKey: string,
    entityId: string,
    tokenId: number,
    amount: bigint
  ): Promise<TxReceipt>;

  /** Withdraw from reserves to EOA */
  withdraw(
    signerPrivateKey: string,
    entityId: string,
    tokenId: number,
    amount: bigint
  ): Promise<TxReceipt>;

  /** Register entity on-chain */
  registerEntity(
    signerPrivateKey: string,
    entityId: string,
    validators: string[],
    threshold: bigint
  ): Promise<TxReceipt>;

  // === DEBUG OPERATIONS (simnet only, no-op on mainnet) ===

  /**
   * Directly fund reserves without deposit flow
   * Only works on browser/simnet - throws on mainnet
   */
  debugFundReserves(entityId: string, tokenId: number, amount: bigint): Promise<void>;

  /**
   * Fund EOA wallet with ETH for gas
   * Only works on browser/simnet - throws on mainnet
   */
  debugFundWallet(address: string, amount: bigint): Promise<void>;
}

/**
 * Jurisdiction registry - TRUE GLOBAL singleton via window
 * Using window ensures the Map survives across dynamic module imports
 */
function getJurisdictionsMap(): Map<string, IJurisdiction> {
  if (typeof window !== 'undefined') {
    // Browser: use window for true global singleton
    if (!(window as any).__xlnJurisdictions) {
      (window as any).__xlnJurisdictions = new Map<string, IJurisdiction>();
    }
    return (window as any).__xlnJurisdictions;
  }
  // Node.js: use module-level map (ok for non-browser)
  return jurisdictionsMap;
}
const jurisdictionsMap = new Map<string, IJurisdiction>();

function getJurisdictionKey(chainId: number, depositoryAddress: string): string {
  return `${chainId}:${depositoryAddress.toLowerCase()}`;
}

/**
 * Get or create jurisdiction instance
 *
 * @example
 * // Browser (simnet)
 * const j = await getJurisdiction({ type: 'browser', chainId: 1337 });
 *
 * // Mainnet (Base)
 * const j = await getJurisdiction({
 *   type: 'rpc',
 *   chainId: 8453,
 *   rpcUrl: 'https://mainnet.base.org',
 *   depositoryAddress: '0x...'
 * });
 */
export async function getJurisdiction(config: JurisdictionConfig): Promise<IJurisdiction> {
  // For RPC, depositoryAddress is required
  if (config.type === 'rpc' && !config.depositoryAddress) {
    throw new Error('depositoryAddress required for RPC jurisdiction');
  }
  if (config.type === 'rpc' && !config.rpcUrl) {
    throw new Error('rpcUrl required for RPC jurisdiction');
  }

  // For browser type, use special key (only ONE browser instance per chainId)
  // For RPC, use chainId:depositoryAddress as key
  const cacheKey = config.type === 'browser'
    ? `browser:${config.chainId}`
    : getJurisdictionKey(config.chainId, config.depositoryAddress!);

  // Check cache (using TRUE global singleton via window)
  const cache = getJurisdictionsMap();
  const existing = cache.get(cacheKey);
  if (existing) {
    console.log(`[Jurisdiction] Returning cached ${config.type} instance:`, cacheKey);
    return existing;
  }

  // Create new jurisdiction
  let jurisdiction: IJurisdiction;

  if (config.type === 'browser') {
    const { BrowserJurisdiction } = await import('./browser-jurisdiction.js');
    jurisdiction = new BrowserJurisdiction(config);
  } else {
    const { RpcJurisdiction } = await import('./rpc-jurisdiction.js');
    jurisdiction = new RpcJurisdiction(config);
  }

  // Initialize (deploys contracts for browser, connects for rpc)
  await jurisdiction.init();

  // Cache by key (TRUE global singleton via window)
  cache.set(cacheKey, jurisdiction);
  console.log(`[Jurisdiction] Created and cached ${config.type} instance:`, cacheKey);

  return jurisdiction;
}

/**
 * Get cached jurisdiction by key (no creation)
 */
export function getCachedJurisdiction(chainId: number, depositoryAddress: string): IJurisdiction | null {
  const key = getJurisdictionKey(chainId, depositoryAddress);
  return getJurisdictionsMap().get(key) || null;
}

/**
 * Clear all cached jurisdictions (for testing)
 */
export function clearJurisdictions(): void {
  getJurisdictionsMap().clear();
}

/**
 * List all active jurisdictions
 */
export function listJurisdictions(): IJurisdiction[] {
  return Array.from(getJurisdictionsMap().values());
}
