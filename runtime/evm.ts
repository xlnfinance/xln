/**
 * XLN EVM Integration
 * Handles blockchain interactions, jurisdictions, and smart contract operations
 *
 * ⚠️ DEPRECATION NOTICE:
 * Contract interaction functions are being migrated to JAdapter (runtime/jadapter/).
 * Use JAdapter for new code:
 *
 *   import { createJAdapter } from './jadapter';
 *   const jAdapter = await createJAdapter({ mode: 'browservm', chainId: 31337 });
 *   await jAdapter.deployStack();
 *
 * Deprecated functions → JAdapter equivalents:
 *   - submitSettle → jAdapter.settle()
 *   - submitProcessBatch → use j-batch.ts broadcastBatch()
 *   - debugFundReserves → jAdapter.debugFundReserves()
 *   - registerNumberedEntityOnChain → jAdapter.registerNumberedEntity()
 *   - registerNumberedEntitiesBatchOnChain → jAdapter.registerNumberedEntitiesBatch()
 *   - submitReserveToReserve → jAdapter.reserveToReserve()
 *   - getNextEntityNumber → jAdapter.getNextEntityNumber()
 *
 * Jurisdiction management functions (getAvailableJurisdictions, setBrowserVMJurisdiction)
 * remain in this file as they handle multi-jurisdiction orchestration.
 */

import { ethers } from 'ethers';
import { loadJurisdictions } from './jurisdiction-loader';
import { encodeJBatch, computeBatchHankoHash, type JBatch } from './j-batch';

import { detectEntityType, encodeBoard, extractNumberFromEntityId, hashBoard } from './entity-factory';
import { normalizeEntityId } from './entity-id-utils';
import { safeStringify } from './serialization-utils';
import type { ConsensusConfig, Env, JurisdictionConfig } from './types';
import { DEBUG, isBrowser } from './utils';
import { logError } from './logger';
import { BrowserVMEthersProvider } from './jadapter/browservm-ethers-provider';
import { parseRebalancePolicyUsd } from './rebalance-policy-usd';
// BrowserVMProvider is also available via jadapter/browservm-provider
import type { BrowserVMInstance } from './xln-api';

const uiLog = (message: string, details?: unknown) => {
  console.log(message, details);
};

const uiError = (message: string, details?: unknown) => {
  logError("BLOCKCHAIN", message, details);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const extractErrorDetails = (error: unknown): Record<string, unknown> => {
  if (!(error instanceof Error) && !isRecord(error)) {
    return { errorType: typeof error, errorMessage: String(error) };
  }

  const details: Record<string, unknown> = {
    errorType: error instanceof Error ? error.constructor.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(Reflect.get(error, 'message') ?? error),
  };

  if (isRecord(error)) {
    const code = Reflect.get(error, 'code');
    const reason = Reflect.get(error, 'reason');
    const stack = Reflect.get(error, 'stack');
    if (code !== undefined) details.errorCode = code;
    if (reason !== undefined) details.errorReason = reason;
    if (typeof stack === 'string') details.errorStack = stack;
  }

  return details;
};

type JurisdictionLoaderPayload = {
  jurisdictions?: Record<string, {
    name?: string;
    chainId?: number;
    rpc?: string;
    rebalancePolicyUsd?: JurisdictionConfig['rebalancePolicyUsd'];
    contracts?: {
      entityProvider?: string;
      depository?: string;
    };
  }>;
};

type BrowserVMCarrier = BrowserVMInstance | {
  browserVM?: BrowserVMInstance | null;
  getProvider?: () => BrowserVMInstance | null;
};

// === ETHEREUM INTEGRATION ===

// Load contract configuration directly in jurisdiction generation
export const ENTITY_PROVIDER_ABI = [
  'function registerNumberedEntity(bytes32 boardHash) external returns (uint256 entityNumber)',
  'function registerNumberedEntitiesBatch(bytes32[] calldata boardHashes) external returns (uint256[] memory entityNumbers)',
  'function assignName(string memory name, uint256 entityNumber) external',
  'function transferName(string memory name, uint256 newEntityNumber) external',
  'function entities(bytes32 entityId) external view returns (tuple(uint256 boardHash, uint8 status, uint256 activationTime))',
  'function nameToNumber(string memory name) external view returns (uint256)',
  'function numberToName(uint256 entityNumber) external view returns (string memory)',
  'function nextNumber() external view returns (uint256)',
  // Governance functions (governance is auto-setup on entity registration)
  'function getTokenIds(uint256 entityNumber) external pure returns (uint256 controlTokenId, uint256 dividendTokenId)',
  'function getGovernanceInfo(uint256 entityNumber) external view returns (uint256 controlTokenId, uint256 dividendTokenId, uint256 controlSupply, uint256 dividendSupply, bool hasActiveProposal, bytes32 articlesHash)',
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data) external',
  // Events
  'event EntityRegistered(bytes32 indexed entityId, uint256 indexed entityNumber, bytes32 boardHash)',
  'event NameAssigned(string indexed name, uint256 indexed entityNumber)',
  'event NameTransferred(string indexed name, uint256 indexed oldEntityNumber, uint256 indexed newEntityNumber)',
  'event GovernanceEnabled(bytes32 indexed entityId, uint256 controlTokenId, uint256 dividendTokenId)',
];

export const DEPOSITORY_ABI = [
  'function mintToReserve(bytes32 entity, uint256 tokenId, uint256 amount) external',
  'function mintToReserveBatch((bytes32 entity, uint256 tokenId, uint256 amount)[] mints) external',
  'function debugFundReserves(bytes32 entity, uint256 tokenId, uint256 amount) external',
  'function debugBulkFundEntities() external',
  'function reserveToReserve(bytes32 fromEntity, bytes32 toEntity, uint256 tokenId, uint256 amount) external returns (bool)',
  'function processBatch(bytes encodedBatch, address entityProvider, bytes hankoData, uint256 nonce) external returns (bool)',
  'function unsafeProcessBatch(bytes32 entity, tuple(tuple(uint256 tokenId, uint256 amount)[] flashloans, tuple(bytes32 receivingEntity, uint256 tokenId, uint256 amount)[] reserveToReserve, tuple(uint256 tokenId, bytes32 receivingEntity, tuple(bytes32 entity, uint256 amount)[] pairs)[] reserveToCollateral, tuple(bytes32 leftEntity, bytes32 rightEntity, tuple(uint256 tokenId, int256 leftDiff, int256 rightDiff, int256 collateralDiff, int256 ondeltaDiff)[] diffs, uint256[] forgiveDebtsInTokenIds, bytes sig, address entityProvider, bytes hankoData, uint256 nonce)[] settlements, tuple(bytes32 counterentity, uint256 nonce, bytes32 proofbodyHash, bytes sig, bytes initialArguments)[] disputeStarts, tuple(bytes32 counterentity, uint256 initialNonce, uint256 finalNonce, bytes32 initialProofbodyHash, tuple(int256[] offdeltas, uint256[] tokenIds, tuple(address transformerAddress, bytes encodedBatch, tuple(uint256 deltaIndex, uint256 rightAllowance, uint256 leftAllowance)[] allowances)[] transformers) finalProofbody, bytes finalArguments, bytes initialArguments, bytes sig, bool startedByLeft, uint256 disputeUntilBlock, bool cooperative)[] disputeFinalizations, tuple(bytes32 entity, address contractAddress, uint96 externalTokenId, uint8 tokenType, uint256 internalTokenId, uint256 amount)[] externalTokenToReserve, tuple(bytes32 receivingEntity, uint256 tokenId, uint256 amount)[] reserveToExternalToken, tuple(address transformer, bytes32 secret)[] revealSecrets, uint256 hub_id) batch) external returns (bool)',
  'function entityNonces(address) view returns (uint256)',
  'function prefundAccount(bytes32 fundingEntity, bytes32 counterpartyEntity, uint256 tokenId, uint256 amount) external returns (bool)',
  'function settle(bytes32 leftEntity, bytes32 rightEntity, tuple(uint256 tokenId, int256 leftDiff, int256 rightDiff, int256 collateralDiff, int256 ondeltaDiff)[] diffs, uint256[] forgiveDebtsInTokenIds, bytes sig) external returns (bool)',
  'function _reserves(bytes32 entity, uint256 tokenId) external view returns (uint256)',
  // Canonical J-Events (must match CANONICAL_J_EVENTS in jadapter/helpers.ts)
  'event ReserveUpdated(bytes32 indexed entity, uint256 indexed tokenId, uint256 newBalance)',
  'event SecretRevealed(bytes32 indexed hashlock, bytes32 indexed revealer, bytes32 secret)',
  'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bytes32 proofbodyHash, bytes initialArguments)',
  'event DisputeFinalized(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed initialNonce, bytes32 initialProofbodyHash, bytes32 finalProofbodyHash)',
  // Note: AccountSettled is emitted via DELEGATECALL from Account.sol - parsed directly from logs
  // Debt events
  'event DebtCreated(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amount, uint256 debtIndex)',
  'event DebtEnforced(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountPaid, uint256 remainingAmount, uint256 newDebtIndex)',
];

export const connectToEthereum = async (jurisdiction: JurisdictionConfig) => {
  // Declare outside try block for error logging
  let rpcUrl = jurisdiction.address;
  let entityProviderAddress = jurisdiction.entityProviderAddress;
  let depositoryAddress = jurisdiction.depositoryAddress;

  try {
    // FINTECH-SAFETY: Validate jurisdiction structure before using

    // Support legacy format with explicit validation
    if (!rpcUrl && 'rpc' in jurisdiction) {
      console.warn('🚨 JURISDICTION-LEGACY: Using deprecated rpc field, should be address');
    }
    if (!entityProviderAddress && 'contracts' in jurisdiction) {
      console.warn('🚨 JURISDICTION-LEGACY: Using deprecated contracts.entityProvider field');
    }

    if (!rpcUrl) {
      throw new Error('Jurisdiction missing RPC URL (address or rpc property)');
    }
    if (!entityProviderAddress || !depositoryAddress) {
      throw new Error('Jurisdiction missing contract addresses (entityProvider and depository)');
    }

    uiLog(`🔌 CONNECTING: jurisdiction=${jurisdiction.name}, rpcUrl=${rpcUrl}`);
    if (isBrowser) {
      uiLog(`   Page Origin: ${window.location.origin}`);
      uiLog(`   Page Protocol: ${window.location.protocol}`);
      uiLog(`   Page Host: ${window.location.hostname}:${window.location.port}`);

      // Handle relative URLs (like /rpc/ethereum) by providing base
      const fullRpcUrl = new URL(rpcUrl, window.location.origin);
      uiLog(`   RPC URL: ${fullRpcUrl.href}`);
      const corsIssue = window.location.origin !== fullRpcUrl.origin;
      uiLog(`   CORS issue? ${corsIssue ? 'YES - Different origins!' : 'No (using proxy)'}`, { corsIssue });
      uiLog(`   User Agent: ${navigator.userAgent}`);
    }
    uiLog(`   Contracts: EP=${entityProviderAddress.slice(0,10)}, DEP=${depositoryAddress.slice(0,10)}`);

    // Resolve relative URLs to full URLs for ethers.js
    let resolvedRpcUrl = rpcUrl;
    if (isBrowser && rpcUrl.startsWith('/')) {
      resolvedRpcUrl = new URL(rpcUrl, window.location.origin).href;
      uiLog(`   Resolved RPC: ${resolvedRpcUrl}`);
    }

    // Connect to specified RPC node (or use BrowserVM provider)
    let provider: ethers.Provider;
    const isBrowserVM = resolvedRpcUrl.startsWith('browservm://');

    if (isBrowserVM) {
      // Use BrowserVM provider (lazy-init if needed)
      // NOTE: This path is for legacy code. New code should use env.browserVM
      if (!BROWSER_VM_INSTANCE) {
        const { BrowserVMProvider } = await import('./jadapter');
        const browserVM = new BrowserVMProvider();
        await browserVM.init();
        // Store in global singleton (backward compat - no env available here)
        BROWSER_VM_INSTANCE = browserVM;
        // Update jurisdictions with this VM's addresses
        const depositoryAddress = browserVM.getDepositoryAddress();
        const entityProviderAddress = browserVM.getEntityProviderAddress();
        DEFAULT_JURISDICTIONS = new Map();
        DEFAULT_JURISDICTIONS.set('simnet', {
          name: 'Simnet',
          chainId: 31337,
          address: 'browservm://',
          entityProviderAddress,
          depositoryAddress,
        });
        console.log('✅ Legacy BrowserVM jurisdiction active (global singleton)');
      }
      if (!BROWSER_VM_INSTANCE) {
        throw new Error('BrowserVM instance not set - failed to initialize BrowserVM');
      }
      if (BROWSER_VM_INSTANCE?.getEntityProviderAddress && (!entityProviderAddress || entityProviderAddress === '0x0000000000000000000000000000000000000000')) {
        entityProviderAddress = BROWSER_VM_INSTANCE.getEntityProviderAddress();
      }
      if (BROWSER_VM_INSTANCE?.getDepositoryAddress && (!depositoryAddress || depositoryAddress === '0x0000000000000000000000000000000000000000')) {
        depositoryAddress = BROWSER_VM_INSTANCE.getDepositoryAddress();
      }
      uiLog(`🧪 Using BrowserVM ethers provider`);
      provider = new BrowserVMEthersProvider(BROWSER_VM_INSTANCE);
    } else {
      // Use standard JSON-RPC provider
      provider = new ethers.JsonRpcProvider(resolvedRpcUrl);
    }

    uiLog(`✅ Provider created`);

    // Use Hardhat account #0 private key (browser-compatible, no getSigner)
    // This is the publicly known Hardhat test key, safe for demo
    const privateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const signer = new ethers.Wallet(privateKey, provider);
    const signerAddress = await signer.getAddress();
    uiLog(`✅ Signer created: ${signerAddress}`);

    // Test connection (skip for BrowserVM to avoid circular dependency issues)
    if (!isBrowserVM) {
      try {
        const network = await provider.getNetwork();
        uiLog(`✅ Network connected: chainId=${network.chainId}`);
      } catch (netError) {
        uiError(`❌ NETWORK-CONNECT-FAILED`, {
          rpcUrl,
          ...extractErrorDetails(netError),
        });
        throw netError;
      }
    } else {
      uiLog(`✅ BrowserVM connection established (chainId=31337)`);
    }

    // Create contract instances
    const entityProvider = new ethers.Contract(entityProviderAddress, ENTITY_PROVIDER_ABI, signer);
    const depository = new ethers.Contract(depositoryAddress, DEPOSITORY_ABI, signer);
    uiLog(`✅ Contracts created for ${jurisdiction.name}`);

    return { provider, signer, entityProvider, depository };
  } catch (error) {
    uiError(`❌ CONNECT-FAILED: ${jurisdiction.name}`, {
      rpcUrl,
      ...extractErrorDetails(error),
    });
    throw error;
  }
};

// Debug function to fund entity reserves for testing
export const debugFundReserves = async (jurisdiction: JurisdictionConfig, entityId: string, tokenId: number, amount: string) => {
  try {
    if (DEBUG) console.log(`💰 DEBUG: Funding entity ${entityId.slice(0, 10)} with ${amount} of token ${tokenId}...`);
    
    const { depository } = await connectToEthereum(jurisdiction);
    
    // Fund the entity's reserves for testing
    const tx = await depository['debugFundReserves']!(entityId, tokenId, amount);
    if (DEBUG) console.log(`📡 Debug funding transaction: ${tx.hash}`);
    
    const receipt = await tx.wait();
    if (DEBUG) console.log(`✅ Debug funding confirmed in block ${receipt.blockNumber}`);
    
    // Check new balance
    const newBalance = await depository['_reserves']!(entityId, tokenId);
    if (DEBUG) console.log(`💰 Entity ${entityId.slice(0, 10)} now has ${newBalance.toString()} of token ${tokenId}`);
    
    return { transaction: tx, receipt, newBalance };
  } catch (error) {
    logError("BLOCKCHAIN", `❌ Failed to fund reserves:`, error);
    throw error;
  }
};

/**
 * Fund entity with multiple assets and emit ReserveUpdated events
 */
export const fundEntityReserves = async (entityId: string, assets: Array<{ tokenId: number; amount: string; symbol: string }>) => {
  console.log(`💰 Funding entity ${entityId.slice(0, 10)}... with ${assets.length} assets`);
  
  for (const asset of assets) {
    console.log(`  💳 Adding ${asset.symbol}: ${asset.amount} (token ${asset.tokenId})`);
    // TODO: Implement fundReserves function or use debugFundReserves
    console.log(`  - Funding ${entityId.slice(0, 10)} with ${asset.amount} of token ${asset.tokenId}`);
  }
  
  console.log(`✅ Entity ${entityId.slice(0, 10)}... funded with all assets`);
};

// Submit real processBatch transaction to jurisdiction
export const submitPrefundAccount = async (jurisdiction: JurisdictionConfig, entityId: string, counterpartyEntityId: string, tokenId: number, amount: string) => {
  try {
    console.log(`💰 Prefunding account between ${entityId.slice(0, 10)}... and ${counterpartyEntityId.slice(0, 10)}...`);
    console.log(`🔍 TOKEN: ${tokenId}, AMOUNT: ${amount}`);
    
    const { depository, provider } = await connectToEthereum(jurisdiction);
    console.log(`🔍 CONTRACT ADDRESS: ${depository.target}`);
    
    // Check if contract exists
    const code = await provider.getCode(depository.target);
    if (code === '0x') {
      throw new Error('Contract not deployed at this address');
    }
    
    // Check entity has sufficient reserves
    const currentBalance = await depository['_reserves']!(entityId, tokenId);
    console.log(`🔍 Current balance: ${currentBalance.toString()}`);
    console.log(`🔍 Requested amount: ${amount}`);
    
    if (currentBalance < BigInt(amount)) {
      throw new Error(`Insufficient reserves: have ${currentBalance.toString()}, need ${amount}`);
    }
    
    // Call prefundAccount function
    console.log(`📞 Calling prefundAccount(${counterpartyEntityId}, ${tokenId}, ${amount})`);
    const tx = await depository['prefundAccount']!(counterpartyEntityId, tokenId, amount);
    console.log(`⏳ Transaction sent: ${tx.hash}`);
    
    // Wait for confirmation
    const receipt = await tx.wait();
    console.log(`✅ Prefunding confirmed in block ${receipt.blockNumber}`);
    
    return {
      hash: tx.hash,
      receipt: receipt
    };
    
  } catch (error) {
    logError("BLOCKCHAIN", `❌ Failed to prefund account:`, error);
    throw error;
  }
};

export const submitProcessBatch = async (
  env: Env,
  jurisdiction: JurisdictionConfig,
  entityId: string,
  batch: JBatch,
  signerId?: string
) => {
  try {
    if (!signerId) {
      throw new Error(`submitProcessBatch требует signerId для ${entityId.slice(0, 10)}`);
    }

    console.log(`💸 Submitting processBatch (Hanko) to ${jurisdiction.name} as entity ${entityId.slice(0, 10)}...`);
    const { depository, provider } = await connectToEthereum(jurisdiction);

    const entityProviderAddress = jurisdiction.entityProviderAddress;
    if (!entityProviderAddress || entityProviderAddress === '0x0000000000000000000000000000000000000000') {
      throw new Error('Jurisdiction missing entityProviderAddress');
    }

    const encodedBatch = encodeJBatch(batch);
    const net = await provider.getNetwork();
    const chainId = BigInt(net.chainId);
    const normalizedEntityId = normalizeEntityId(entityId);
    const entityAddress = ethers.getAddress(`0x${normalizedEntityId.slice(-40)}`);
    const currentNonce = await depository['entityNonces']?.(entityAddress);
    const nextNonce = BigInt(currentNonce ?? 0) + 1n;
    const batchHash = computeBatchHankoHash(chainId, String(depository.target), encodedBatch, nextNonce);

    const { signHashesAsSingleEntity } = await import('./hanko-signing');
    const hankos = await signHashesAsSingleEntity(env, entityId, signerId, [batchHash]);
    const hankoData = hankos[0];
    if (!hankoData) {
      throw new Error('Failed to build batch hanko signature');
    }

    const tx = await depository['processBatch']!(encodedBatch, entityProviderAddress, hankoData, nextNonce);
    console.log(`📡 Transaction submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);

    return { transaction: tx, receipt };
  } catch (error) {
    logError("BLOCKCHAIN", `❌ Failed to submit processBatch to ${jurisdiction.name}:`, error);
    throw error;
  }
};

// Note: setupGovernance is no longer needed - governance is automatically created on entity registration

export const registerNumberedEntityOnChain = async (
  config: ConsensusConfig,
  name: string,
): Promise<{ txHash: string; entityNumber: number }> => {
  if (!config.jurisdiction) {
    throw new Error('Jurisdiction required for on-chain registration');
  }

  try {
    const { entityProvider } = await connectToEthereum(config.jurisdiction);

    const encodedBoard = encodeBoard(config);
    const boardHash = hashBoard(encodedBoard);

    if (DEBUG) console.log(`🏛️ Registering numbered entity "${name}" on chain`);
    if (DEBUG) console.log(`   Jurisdiction: ${config.jurisdiction.name}`);
    if (DEBUG) console.log(`   EntityProvider: ${config.jurisdiction.entityProviderAddress}`);
    if (DEBUG) console.log(`   Board Hash: ${boardHash}`);

    // Test connection by calling nextNumber()
    try {
      const nextNumber = await entityProvider['nextNumber']!();
      if (DEBUG) console.log(`   📊 Next entity number will be: ${nextNumber}`);
    } catch (error) {
      throw new Error(`Failed to call nextNumber(): ${error}`);
    }

    // Call the smart contract
    const tx = await entityProvider['registerNumberedEntity']!(boardHash);
    if (DEBUG) console.log(`   📤 Transaction sent: ${tx.hash}`);

    // Wait for confirmation
    const receipt = await tx.wait();
    if (DEBUG) console.log(`   ✅ Transaction confirmed in block ${receipt.blockNumber}`);

    // Check if transaction reverted
    if (receipt.status === 0) {
      throw new Error(`Transaction reverted! Hash: ${tx.hash}`);
    }

    // Debug: log all events in receipt
    if (DEBUG) {
      console.log(`   📋 Receipt logs count: ${receipt.logs.length}`);
      receipt.logs.forEach((log: ethers.Log, i: number) => {
        try {
          const parsed = entityProvider.interface.parseLog(log);
          console.log(`   📝 Log ${i}: ${parsed?.name} - ${safeStringify(parsed?.args)}`);
        } catch {
          console.log(`   📝 Log ${i}: Unable to parse log - ${log.topics?.[0]}`);
        }
      });
    }

    // Extract entity number from event logs
    const event = receipt.logs.find((log: ethers.Log) => {
      try {
        const parsed = entityProvider.interface.parseLog(log);
        return parsed?.name === 'EntityRegistered';
      } catch {
        return false;
      }
    });

    if (!event) {
      throw new Error('EntityRegistered event not found in transaction logs');
    }

    const parsedEvent = entityProvider.interface.parseLog(event);
    // const _entityId = parsedEvent?.args[0]; // Entity ID for debugging (unused)
    const entityNumber = Number(parsedEvent?.args[1]);

    if (DEBUG) console.log(`✅ Numbered entity registered!`);
    if (DEBUG) console.log(`   TX: ${tx.hash}`);
    if (DEBUG) console.log(`   Entity Number: ${entityNumber}`);

    return { txHash: tx.hash, entityNumber };
  } catch (error) {
    logError("BLOCKCHAIN", '❌ Blockchain registration failed:', error);
    throw error;
  }
};

/**
 * Batch register multiple numbered entities in ONE transaction
 * Massive speedup for scenario imports (1000 entities in 1 tx vs 1000 txs)
 */
export const registerNumberedEntitiesBatchOnChain = async (
  configs: ConsensusConfig[],
  jurisdiction: JurisdictionConfig,
): Promise<{ txHash: string; entityNumbers: number[] }> => {
  try {
    // Encode all board hashes
    const boardHashes = configs.map(config => {
      const encodedBoard = encodeBoard(config);
      return hashBoard(encodedBoard);
    });

    console.log(`🏛️ Batch registering ${configs.length} entities in ONE transaction...`);

    // BrowserVM: Use direct call to avoid circular dependencies
    if (jurisdiction.address.startsWith('browservm://')) {
      if (!BROWSER_VM_INSTANCE) {
        throw new Error('BrowserVM instance not set');
      }
      return await BROWSER_VM_INSTANCE.registerNumberedEntitiesBatch(boardHashes);
    }

    // Standard blockchain: Use ethers.js
    const { entityProvider } = await connectToEthereum(jurisdiction);

    // Call batch registration function
    const tx = await entityProvider['registerNumberedEntitiesBatch']!(boardHashes);
    console.log(`📤 Batch tx sent: ${tx.hash}`);

    // Wait for confirmation (ONE block for ALL entities!)
    const receipt = await tx.wait();
    console.log(`✅ Batch confirmed in block ${receipt.blockNumber}`);

    if (receipt.status === 0) {
      throw new Error(`Batch registration reverted! Hash: ${tx.hash}`);
    }

    // Extract all entity numbers from events
    const entityNumbers: number[] = [];
    receipt.logs.forEach((log: ethers.Log) => {
      try {
        const parsed = entityProvider.interface.parseLog(log);
        if (parsed?.name === 'EntityRegistered') {
          entityNumbers.push(Number(parsed.args[1]));
        }
      } catch {
        // Skip unparseable logs
      }
    });

    console.log(`✅ Registered ${entityNumbers.length} entities: ${entityNumbers[0]}-${entityNumbers[entityNumbers.length - 1]}`);

    return { txHash: tx.hash, entityNumbers };
  } catch (error) {
    logError("BLOCKCHAIN", '❌ Batch registration failed:', error);
    throw error;
  }
};

export const assignNameOnChain = async (
  name: string,
  entityNumber: number,
  jurisdiction: JurisdictionConfig,
): Promise<{ txHash: string }> => {
  try {
    const { entityProvider } = await connectToEthereum(jurisdiction);

    if (DEBUG) console.log(`🏷️  Assigning name "${name}" to entity #${entityNumber}`);

    // Call the smart contract (admin only)
    const tx = await entityProvider['assignName']!(name, entityNumber);
    if (DEBUG) console.log(`   📤 Transaction sent: ${tx.hash}`);

    // Wait for confirmation
    const receipt = await tx.wait();
    if (DEBUG) console.log(`   ✅ Transaction confirmed in block ${receipt.blockNumber}`);

    // Check if transaction reverted
    if (receipt.status === 0) {
      throw new Error(`Transaction reverted! Hash: ${tx.hash}`);
    }

    if (DEBUG) console.log(`✅ Name assigned successfully!`);
    if (DEBUG) console.log(`   TX: ${tx.hash}`);

    return { txHash: tx.hash };
  } catch (error) {
    logError("BLOCKCHAIN", '❌ Name assignment failed:', error);
    throw error;
  }
};

export const getEntityInfoFromChain = async (
  entityId: string,
  jurisdiction: JurisdictionConfig,
): Promise<{ exists: boolean; entityNumber?: number; name?: string }> => {
  try {
    const { entityProvider } = await connectToEthereum(jurisdiction);

    // Try to get entity info
    const entityInfo = await entityProvider['entities']!(entityId);

    if (entityInfo.status === 0) {
      return { exists: false };
    }

    // For numbered entities, get the number and name
    const entityType = detectEntityType(entityId);
    let entityNumber: number | undefined;
    let name: string | undefined;

    if (entityType === 'numbered') {
      const extractedNumber = extractNumberFromEntityId(entityId);
      if (extractedNumber !== null) {
        entityNumber = extractedNumber;
        try {
          const retrievedName = await entityProvider['numberToName']!(entityNumber);
          name = retrievedName || undefined;
        } catch {
          // No name assigned
        }
      }
    }

    return {
      exists: true,
      ...(entityNumber !== undefined ? { entityNumber } : {}),
      ...(name !== undefined ? { name } : {})
    };
  } catch (error) {
    logError("BLOCKCHAIN", '❌ Failed to get entity info from chain:', error);
    return { exists: false };
  }
};

export const getNextEntityNumber = async (jurisdiction: JurisdictionConfig): Promise<number> => {
  try {
    if (!jurisdiction) {
      throw new Error('Jurisdiction parameter is required');
    }

    // Support both direct property and nested under contracts with type safety
    let entityProviderAddress = jurisdiction.entityProviderAddress;

    if (!entityProviderAddress && 'contracts' in jurisdiction) {
      const jurisdictionWithContracts = jurisdiction as Record<string, unknown> & { contracts?: { entityProvider?: string } };
      const contractAddress = jurisdictionWithContracts.contracts?.entityProvider;
      if (contractAddress) {
        entityProviderAddress = contractAddress;
      }
    }

    if (!jurisdiction.name || !entityProviderAddress) {
      throw new Error('Jurisdiction object is missing required properties (name, entityProvider address)');
    }

    const { entityProvider } = await connectToEthereum(jurisdiction);

    if (DEBUG)
      console.log(`🔍 Fetching next entity number from ${entityProviderAddress} (${jurisdiction.name})`);

    const nextNumber = await entityProvider['nextNumber']!();
    const result = Number(nextNumber);

    if (DEBUG) console.log(`🔢 Next entity number: ${result}`);
    return result;
  } catch (error) {
    logError("BLOCKCHAIN", '❌ Failed to get next entity number:', error);
    throw error;
  }
};

export const transferNameBetweenEntities = async (
  name: string,
  fromNumber: number,
  toNumber: number,
  _jurisdiction: JurisdictionConfig,
): Promise<string> => {
  if (DEBUG) console.log(`🔄 Transferring name "${name}" from #${fromNumber} to #${toNumber}`);

  // TODO: Implement real blockchain name transfer
  throw new Error('Name transfer not implemented - requires blockchain integration');
};

// === JURISDICTION MANAGEMENT ===

// Load contract configuration and generate jurisdictions
export const generateJurisdictions = async (): Promise<Map<string, JurisdictionConfig>> => {

  const jurisdictions = new Map<string, JurisdictionConfig>();
  const browserJurisdictionsUrl = `./api/jurisdictions?ts=${Date.now()}`;

  try {
    let config: JurisdictionLoaderPayload;

    if (!isBrowser && typeof process !== 'undefined') {
      // Node.js environment - use centralized loader
      if (DEBUG) console.log('🔍 JURISDICTION SOURCE: Using centralized jurisdiction-loader');
      config = loadJurisdictions();
      if (DEBUG) console.log('🔍 JURISDICTION DEBUG: Loaded config with contracts:', config.jurisdictions?.ethereum?.contracts);
      if (DEBUG) console.log('✅ Loaded jurisdictions from centralized loader (cached)');
    } else {
      // Browser environment - fetch from runtime with timeout (prevents indefinite hang in BrowserVM mode)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout

      try {
        const response = await fetch(browserJurisdictionsUrl, {
          signal: controller.signal,
          cache: 'no-store',
          headers: { 'cache-control': 'no-cache' },
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
          throw new Error(`Failed to fetch /api/jurisdictions: ${response.status} ${response.statusText}`);
        }
        config = await response.json();
        if (DEBUG) console.log('🔍 JURISDICTION DEBUG: Browser loaded config with contracts:', config.jurisdictions?.ethereum?.contracts);
        if (DEBUG) console.log('✅ Loaded jurisdictions from runtime');
      } catch (fetchError: unknown) {
        clearTimeout(timeoutId);
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          console.log('⏱️ /api/jurisdictions fetch timed out - using BrowserVM mode (no external blockchain)');
        } else {
          console.log('⚠️ /api/jurisdictions not found - using BrowserVM mode (no external blockchain)');
        }
        // Return empty map for BrowserVM mode - scenarios handle their own fallback
        return jurisdictions;
      }
    }

    const jurisdictionData = config.jurisdictions;
    const globalRebalancePolicyUsd = parseRebalancePolicyUsd(config?.defaults?.rebalancePolicyUsd);

    // Build jurisdictions from loaded config with type safety
    for (const [key, data] of Object.entries(jurisdictionData)) {
      // Validate structure before using
      if (!data || typeof data !== 'object') {
        console.warn(`🚨 Invalid jurisdiction data for ${key}:`, data);
        continue;
      }
      const jData = data as Record<string, any>;

      // CRITICAL: Check for RPC override (for Oculus Quest compatibility)
      let rpcUrl = jData['rpc'];

      // Detect Oculus Browser (blocks custom ports on HTTPS - security restriction)
      const isOculusBrowser = isBrowser && /OculusBrowser|Quest/i.test(navigator.userAgent);

      const rpcOverride = isBrowser ? localStorage.getItem('xln_rpc_override') : null;

      uiLog(`🔍 RPC-TRANSFORM-START: key=${key}, rpc=${rpcUrl}`, {
        isOculusBrowser,
        override: rpcOverride,
        userAgent: isBrowser ? navigator.userAgent : 'N/A'
      });

      // Oculus Browser fix: Force direct port without +10000 offset
      if (isOculusBrowser && !rpcOverride && rpcUrl.startsWith(':')) {
        const port = parseInt(rpcUrl.slice(1));
        rpcUrl = `${window.location.protocol}//${window.location.hostname}:${port}`;
        uiLog(`🎮 OCULUS FIX: Using direct port ${port} → ${rpcUrl}`);
      }

      if (rpcOverride && rpcOverride !== '') {
        // User-specified RPC override
        if (rpcOverride.startsWith('/')) {
          // Path-based proxy (e.g., /rpc or /rpc/ethereum)
          // If single jurisdiction, use path directly. If multiple, append jurisdiction name.
          const jurisdictionCount = Object.keys(config.jurisdictions).length;
          const path = jurisdictionCount === 1
            ? rpcOverride  // Single jurisdiction: use /rpc directly
            : (rpcOverride.endsWith('/') ? rpcOverride + jData['name'].toLowerCase() : `${rpcOverride}/${jData['name'].toLowerCase()}`);
          rpcUrl = `${window.location.origin}${path}`;
          uiLog(`🔧 RPC URL (override): ${jData['rpc']} → ${rpcUrl} (path proxy, ${jurisdictionCount} jurisdictions)`);
        } else if (rpcOverride.startsWith(':')) {
          // Port-based (e.g., :8545 or :18545)
          rpcUrl = `${window.location.protocol}//${window.location.hostname}${rpcOverride}`;
          uiLog(`🔧 RPC URL (override): ${jData['rpc']} → ${rpcUrl} (custom port)`);
        } else {
          // Full URL override
          rpcUrl = rpcOverride;
          uiLog(`🔧 RPC URL (override): ${jData['rpc']} → ${rpcUrl} (full URL)`);
        }
      } else if (isBrowser && rpcUrl.startsWith('/')) {
        // Path-based proxy (e.g., /rpc/simnet) - use same origin
        rpcUrl = `${window.location.origin}${rpcUrl}`;
        uiLog(`🔧 RPC-TRANSFORM-PROXY: ${jData['rpc']} → ${rpcUrl}`, {
          origin: window.location.origin,
          proxyPath: jData['rpc']
        });
      } else if (isBrowser && rpcUrl.startsWith(':')) {
        // Port-based (legacy): production uses port + 10000 (nginx proxy)
        const port = parseInt(rpcUrl.slice(1));
        const isLocalhost = window.location.hostname.match(/localhost|127\.0\.0\.1/);
        const actualPort = isLocalhost ? port : port + 10000;
        rpcUrl = `${window.location.protocol}//${window.location.hostname}:${actualPort}`;
        uiLog(`🔧 RPC-TRANSFORM-DEFAULT: ${jData['rpc']} → ${rpcUrl}`, {
          hostname: window.location.hostname,
          isLocalhost: !!isLocalhost,
          port,
          actualPort,
          portOffset: isLocalhost ? 0 : 10000
        });
      } else if (!isBrowser && rpcUrl.startsWith(':')) {
        // Node.js: Default to localhost
        rpcUrl = `http://localhost${rpcUrl}`;
      }

      uiLog(`📍 FINAL-RPC-URL: ${key} → ${rpcUrl}`, {
        entityProvider: jData['contracts']['entityProvider'],
        depository: jData['contracts']['depository']
      });

      const rebalancePolicyUsd = parseRebalancePolicyUsd(jData['rebalancePolicyUsd']) ?? globalRebalancePolicyUsd;
      jurisdictions.set(key, {
        address: rpcUrl,
        name: jData['name'],
        entityProviderAddress: jData['contracts']['entityProvider'],
        depositoryAddress: jData['contracts']['depository'],
        chainId: jData['chainId'],
        ...(rebalancePolicyUsd ? { rebalancePolicyUsd } : {}),
      });
    }
  } catch (error) {
    logError("BLOCKCHAIN", '❌ Failed to load jurisdictions:', error);
  }

  return jurisdictions;
};

export let DEFAULT_JURISDICTIONS: Map<string, JurisdictionConfig> | null = null;

export const getJurisdictions = async (): Promise<Map<string, JurisdictionConfig>> => {
  // In browser, cache the result to avoid multiple fetches
  if (isBrowser && DEFAULT_JURISDICTIONS !== null) {
    console.log('🔍 JURISDICTIONS: Using cached browser data');
    return DEFAULT_JURISDICTIONS;
  }

  // Generate/fetch jurisdictions
  DEFAULT_JURISDICTIONS = await generateJurisdictions();
  return DEFAULT_JURISDICTIONS!;
};

export const getAvailableJurisdictions = async (): Promise<JurisdictionConfig[]> => {
  const jurisdictions = await getJurisdictions();
  return Array.from(jurisdictions.values());
};

// DEPRECATED: Use env.browserVM instead of global singleton
let BROWSER_VM_INSTANCE: BrowserVMInstance | null = null;

/**
 * Set BrowserVM jurisdiction (for isolated /view environments)
 * @param env - Runtime environment to store BrowserVM instance
 * @param depositoryAddress - Depository contract address
 * @param browserVMInstance - Optional pre-initialized BrowserVM instance
 */
export const setBrowserVMJurisdiction = (env: Env | null, depositoryAddress: string, browserVMInstance?: BrowserVMCarrier | null) => {
  console.log('[BrowserVM] Setting jurisdiction override:', { depositoryAddress, hasBrowserVM: !!browserVMInstance, hasEnv: !!env });

  const wrappedBrowserVM = browserVMInstance && isRecord(browserVMInstance) && 'browserVM' in browserVMInstance
    ? browserVMInstance.browserVM ?? null
    : browserVMInstance ?? null;
  const resolvedBrowserVM =
    wrappedBrowserVM && isRecord(wrappedBrowserVM) && typeof Reflect.get(wrappedBrowserVM, 'getProvider') === 'function'
      ? ((Reflect.get(wrappedBrowserVM, 'getProvider') as () => BrowserVMInstance | null)() ?? null)
      : wrappedBrowserVM;
  console.log('[BrowserVM] rawBrowserVM:', !!wrappedBrowserVM, 'resolvedBrowserVM:', !!resolvedBrowserVM);

  // Store browserVM instance in env (isolated per-runtime)
  // NOTE: J-event forwarding is handled by JAdapter.startWatching() — not here.
  // This function only stores the BrowserVM reference and sets up DEFAULT_JURISDICTIONS.
  if (resolvedBrowserVM && env) {
    env.browserVM = resolvedBrowserVM;
    console.log('[BrowserVM] Stored browserVM instance in env (isolated)');
  } else {
    console.warn('[BrowserVM] FAILED to store: resolvedBrowserVM=', !!resolvedBrowserVM, 'env=', !!env);
  }

  // BACKWARD COMPAT: Also store in global for legacy code
  if (resolvedBrowserVM) {
    BROWSER_VM_INSTANCE = resolvedBrowserVM;
  }

  const resolveEntityProvider = () => {
    if (resolvedBrowserVM?.getEntityProviderAddress) return resolvedBrowserVM.getEntityProviderAddress();
    if (env?.browserVM?.getEntityProviderAddress) return env.browserVM.getEntityProviderAddress();
    if (BROWSER_VM_INSTANCE?.getEntityProviderAddress) return BROWSER_VM_INSTANCE.getEntityProviderAddress();
    return '0x0000000000000000000000000000000000000000';
  };

  const entityProviderAddress = resolveEntityProvider();
  if (!entityProviderAddress || entityProviderAddress === '0x0000000000000000000000000000000000000000') {
    console.warn('[BrowserVM] EntityProvider address missing - numbered entities will fail until EP is deployed.');
  }

  DEFAULT_JURISDICTIONS = new Map();
  DEFAULT_JURISDICTIONS.set('simnet', {
    name: 'Simnet',
    chainId: 31337,
    address: 'browservm://', // BrowserVM uses in-memory EVM, no real RPC
    entityProviderAddress,
    depositoryAddress,
  });

  console.log('✅ BrowserVM jurisdiction active - numbered entities will register here');
};

export const getJurisdictionByAddress = async (address: string): Promise<JurisdictionConfig | undefined> => {
  const jurisdictions = await getJurisdictions();
  return jurisdictions.get(address);
};

/**
 * Get BrowserVM instance (for demos that need direct BrowserVM access)
 * Uses env.browserVM only (no legacy global fallback)
 */
export const getBrowserVMInstance = (env?: Env | null): BrowserVMInstance | null => {
  return env?.browserVM ?? null;
};

// Settlement diff structure matching contract
export interface SettlementDiff {
  tokenId: number;
  leftDiff: bigint;
  rightDiff: bigint;
  collateralDiff: bigint;
  ondeltaDiff?: bigint; // Optional in some contexts
}

export const submitSettle = async (
  jurisdiction: JurisdictionConfig,
  leftEntity: string,
  rightEntity: string,
  diffs: SettlementDiff[],
  forgiveDebtsInTokenIds: number[] = [],
  sig?: string
) => {
  try {
    console.log(`⚖️ Submitting settle transaction between ${leftEntity.slice(0, 10)}... and ${rightEntity.slice(0, 10)}...`);
    console.log(`🔍 DIFFS:`, diffs.map(d => ({
      ...d,
      leftDiff: d.leftDiff.toString(),
      rightDiff: d.rightDiff.toString(),
      collateralDiff: d.collateralDiff.toString()
    })));

    const hasChanges = diffs.length > 0 || forgiveDebtsInTokenIds.length > 0;
    if (hasChanges && (!sig || sig === '0x')) {
      throw new Error('Settlement signature required for settle');
    }
    const finalSig = sig || '0x';

    const { depository, provider } = await connectToEthereum(jurisdiction);
    console.log(`🔍 CONTRACT ADDRESS: ${depository.target}`);

    // Check if contract exists
    const code = await provider.getCode(depository.target);
    if (code === '0x') {
      throw new Error('Contract not deployed at this address');
    }

    // Call settle function
    console.log(`📤 Calling settle function...`);
    const tx = await depository['settle']!(
      leftEntity,
      rightEntity,
      diffs,
      forgiveDebtsInTokenIds,
      finalSig
    );
    console.log(`💫 Transaction sent: ${tx.hash}`);

    // Wait for confirmation
    const receipt = await tx.wait();
    console.log(`✅ Settlement confirmed in block ${receipt.blockNumber}`);

    if (receipt.status === 0) {
      throw new Error(`Settlement transaction reverted! Hash: ${tx.hash}`);
    }

    console.log(`🎉 Settlement successful! Both entities should receive SettlementProcessed events`);
    return { txHash: tx.hash, blockNumber: receipt.blockNumber };

  } catch (error) {
    logError("BLOCKCHAIN", '❌ Settlement failed:', error);
    throw error;
  }
};

export const submitReserveToReserve = async (jurisdiction: JurisdictionConfig, fromEntity: string, toEntity: string, tokenId: number, amount: string) => {
  try {
    console.log(`💸 DIRECT R2R: ${fromEntity.slice(0,10)} → ${toEntity.slice(0,10)}, token ${tokenId}, amount ${amount}`);

    const { depository, provider } = await connectToEthereum(jurisdiction);
    console.log(`🔍 CONTRACT ADDRESS: ${depository.target}`);

    // Check if contract exists
    const code = await provider.getCode(depository.target);
    if (code === '0x') {
      throw new Error('Contract not deployed at this address');
    }

    // Call direct reserveToReserve function
    console.log(`📤 Calling reserveToReserve(${fromEntity}, ${toEntity}, ${tokenId}, ${amount})...`);
    const tx = await depository['reserveToReserve']!(fromEntity, toEntity, tokenId, amount);
    console.log(`💫 Transaction sent: ${tx.hash}`);

    // Wait for confirmation
    const receipt = await tx.wait();
    console.log(`✅ R2R confirmed in block ${receipt.blockNumber}`);

    if (receipt.status === 0) {
      throw new Error(`R2R transaction reverted! Hash: ${tx.hash}`);
    }

    console.log(`🎉 Direct R2R successful!`);
    return { txHash: tx.hash, blockNumber: receipt.blockNumber };

  } catch (error) {
    logError("BLOCKCHAIN", '❌ Direct R2R failed:', error);
    throw error;
  }
};
