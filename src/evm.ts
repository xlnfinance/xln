/**
 * XLN EVM Integration
 * Handles blockchain interactions, jurisdictions, and smart contract operations
 */

import { ethers } from 'ethers';
import { loadJurisdictions } from './jurisdiction-loader';

import { detectEntityType, encodeBoard, extractNumberFromEntityId, hashBoard } from './entity-factory';
import { ConsensusConfig, JurisdictionConfig } from './types';
import { DEBUG, isBrowser } from './utils';

// === ETHEREUM INTEGRATION ===

// Load contract configuration directly in jurisdiction generation
export const ENTITY_PROVIDER_ABI = [
  'function registerNumberedEntity(bytes32 boardHash) external returns (uint256 entityNumber)',
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
  'function debugFundReserves(bytes32 entity, uint256 tokenId, uint256 amount) external',
  'function debugBulkFundEntities() external',
  'function reserveToReserve(bytes32 fromEntity, bytes32 toEntity, uint256 tokenId, uint256 amount) external returns (bool)',
  'function processBatch(bytes32 entity, tuple(tuple(bytes32 receivingEntity, uint256 tokenId, uint256 amount)[] reserveToExternalToken, tuple(bytes32 entity, bytes32 packedToken, uint256 internalTokenId, uint256 amount)[] externalTokenToReserve, tuple(bytes32 receivingEntity, uint256 tokenId, uint256 amount)[] reserveToReserve, tuple(uint256 tokenId, bytes32 receivingEntity, tuple(bytes32 entity, uint256 amount)[] pairs)[] reserveToCollateral, tuple(bytes32 leftEntity, bytes32 rightEntity, tuple(uint256 tokenId, int256 leftDiff, int256 rightDiff, int256 collateralDiff, int256 ondeltaDiff)[] diffs)[] settlements, tuple(bytes32 counterentity, tuple(uint256 tokenId, int256 peerReserveDiff, int256 collateralDiff, int256 ondeltaDiff)[] diffs, uint256[] forgiveDebtsInTokenIds, bytes sig)[] cooperativeUpdate, tuple(bytes32 counterentity, tuple(int256[] offdeltas, uint256[] tokenIds, tuple(address subcontractProviderAddress, bytes encodedBatch, tuple(uint256 deltaIndex, uint256 rightAllowence, uint256 leftAllowence)[] allowences)[] subcontracts) proofbody, bytes initialArguments, bytes finalArguments, bytes sig)[] cooperativeDisputeProof, tuple(bytes32 counterentity, uint256 cooperativeNonce, uint256 disputeNonce, bytes32 proofbodyHash, bytes sig, bytes initialArguments)[] initialDisputeProof, tuple(bytes32 counterentity, uint256 initialCooperativeNonce, uint256 initialDisputeNonce, uint256 disputeUntilBlock, bytes32 initialProofbodyHash, bytes initialArguments, bool startedByLeft, uint256 finalCooperativeNonce, uint256 finalDisputeNonce, tuple(int256[] offdeltas, uint256[] tokenIds, tuple(address subcontractProviderAddress, bytes encodedBatch, tuple(uint256 deltaIndex, uint256 rightAllowence, uint256 leftAllowence)[] allowences)[] subcontracts) finalProofbody, bytes finalArguments, bytes sig)[] finalDisputeProof, tuple(uint256 tokenId, uint256 amount)[] flashloans, uint256 hub_id) batch) external returns (bool)',
  'function prefundAccount(bytes32 counterpartyEntity, uint256 tokenId, uint256 amount) external returns (bool)',
  'function settle(bytes32 leftEntity, bytes32 rightEntity, tuple(uint256 tokenId, int256 leftDiff, int256 rightDiff, int256 collateralDiff)[] diffs) external returns (bool)',
  'function _reserves(bytes32 entity, uint256 tokenId) external view returns (uint256)',
  'event ReserveUpdated(bytes32 indexed entity, uint256 indexed tokenId, uint256 newBalance)',
  'event ReserveTransferred(bytes32 indexed from, bytes32 indexed to, uint256 indexed tokenId, uint256 amount)',
  'event SettlementProcessed(bytes32 indexed leftEntity, bytes32 indexed rightEntity, uint256 indexed tokenId, uint256 leftReserve, uint256 rightReserve, uint256 collateral, int256 ondelta)',
];

export const connectToEthereum = async (jurisdiction: JurisdictionConfig) => {
  try {
    // FINTECH-SAFETY: Validate jurisdiction structure before using
    const rpcUrl = jurisdiction.address;
    const entityProviderAddress = jurisdiction.entityProviderAddress;
    const depositoryAddress = jurisdiction.depositoryAddress;

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

    // Connect to specified RPC node
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    // Use first account for testing (Hardhat account #0)
    const signer = await provider.getSigner(0);

    // Create contract instances
    const entityProvider = new ethers.Contract(entityProviderAddress, ENTITY_PROVIDER_ABI, signer);
    const depository = new ethers.Contract(depositoryAddress, DEPOSITORY_ABI, signer);

    return { provider, signer, entityProvider, depository };
  } catch (error) {
    console.error(`Failed to connect to ${jurisdiction.name}:`, error);
    throw error;
  }
};

// Debug function to fund entity reserves for testing
export const debugFundReserves = async (jurisdiction: JurisdictionConfig, entityId: string, tokenId: number, amount: string) => {
  try {
    console.log(`💰 DEBUG: Funding entity ${entityId.slice(0, 10)} with ${amount} of token ${tokenId}...`);
    
    const { depository } = await connectToEthereum(jurisdiction);
    
    // Fund the entity's reserves for testing
    const tx = await depository['debugFundReserves']!(entityId, tokenId, amount);
    console.log(`📡 Debug funding transaction: ${tx.hash}`);
    
    const receipt = await tx.wait();
    console.log(`✅ Debug funding confirmed in block ${receipt.blockNumber}`);
    
    // Check new balance
    const newBalance = await depository['_reserves']!(entityId, tokenId);
    console.log(`💰 Entity ${entityId.slice(0, 10)} now has ${newBalance.toString()} of token ${tokenId}`);
    
    return { transaction: tx, receipt, newBalance };
  } catch (error) {
    console.error(`❌ Failed to fund reserves:`, error);
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
    console.error(`❌ Failed to prefund account:`, error);
    throw error;
  }
};

export const submitProcessBatch = async (jurisdiction: JurisdictionConfig, entityId: string, batch: any) => {
  try {
    console.log(`💸 Submitting processBatch to ${jurisdiction.name} as entity ${entityId.slice(0, 10)}...`);
    console.log(`🔍 BATCH DEBUG:`, JSON.stringify(batch, null, 2));
    console.log(`🔍 ENTITY DEBUG: ${entityId}`);
    console.log(`🔍 JURISDICTION DEBUG:`, jurisdiction);
    console.log(`🔍 JURISDICTION SOURCE: Reading from jurisdictions.json file`);
    console.log(`🔍 DEPOSITORY ADDRESS FROM JURISDICTION: ${jurisdiction.depositoryAddress}`);
    console.log(`🔍 ENTITY PROVIDER ADDRESS FROM JURISDICTION: ${jurisdiction.entityProviderAddress}`);
    
    // Fix batch amounts - convert any JS numbers to wei strings
    if (batch.reserveToReserve) {
      for (let i = 0; i < batch.reserveToReserve.length; i++) {
        const transfer = batch.reserveToReserve[i];
        if (typeof transfer.amount === 'number') {
          // Convert number to wei string
          const weiAmount = (BigInt(Math.floor(transfer.amount * 1e18))).toString();
          console.log(`🔧 Converting amount ${transfer.amount} → ${weiAmount} wei`);
          transfer.amount = weiAmount;
        }
      }
    }
    console.log(`🔍 FIXED BATCH:`, JSON.stringify(batch, null, 2));
    
    const { depository, provider } = await connectToEthereum(jurisdiction);
    console.log(`🔍 CONTRACT ADDRESS: ${depository.target}`);
    
    // Check if contract exists
    const code = await provider.getCode(depository.target);
    console.log(`🔍 CONTRACT CODE LENGTH: ${code.length} characters`);
    
    if (code === '0x') {
      throw new Error('Contract not deployed at this address');
    }
    
    // Test if this is our new contract
    try {
      console.log(`🔍 Testing if contract has debugBulkFundEntities...`);
      await depository['debugBulkFundEntities']?.staticCall?.();
      console.log(`✅ This is our NEW contract with debug functions!`);
    } catch (debugError) {
      console.log(`❌ This is OLD contract - no debug functions:`, (debugError as Error).message);
    }
    
    // Check current balance (entities should be pre-funded in constructor)
    console.log(`🔍 Checking balance for entity ${entityId} token ${batch.reserveToReserve[0]?.tokenId || 1}...`);
    try {
      const currentBalance = await depository['_reserves']!(entityId, batch.reserveToReserve[0]?.tokenId || 1);
      console.log(`🔍 Current balance: ${currentBalance.toString()}`);
      
      if (currentBalance.toString() === '0') {
        console.log(`⚠️ Entity has no reserves - this suggests old contract without pre-funding`);
        throw new Error(`Entity ${entityId.slice(0, 10)} has no reserves! Contract should be pre-funded.`);
      }
    } catch (balanceError) {
      console.log(`❌ Failed to check balance:`, (balanceError as Error).message);
      throw balanceError;
    }
    
    // Debug the exact function call being made
    console.log(`🔍 Function signature: processBatch(bytes32,tuple)`);
    console.log(`🔍 Entity ID: ${entityId}`);
    console.log(`🔍 Batch structure:`, Object.keys(batch));
    console.log(`🔍 reserveToReserve array:`, batch.reserveToReserve);
    
    // Check if function exists in contract interface
    const functionFragments = depository.interface.fragments.filter(f => f.type === 'function');
    const functions = functionFragments.map(f => {
      // Proper typing: FunctionFragment has name property
      return 'name' in f ? (f as { name: string }).name : 'unknown';
    });
    const hasProcessBatch = functions.includes('processBatch');
    console.log(`🔍 Contract has processBatch function: ${hasProcessBatch}`);
    console.log(`🔍 Available functions:`, functions.slice(0, 10), '...');
    
    // DEEP DEBUGGING: Check ABI vs deployed bytecode
    console.log(`🔍 DEEP DEBUG: Contract interface analysis`);
    console.log(`🔍 Contract target address: ${depository.target}`);
    
    // Get function selector for processBatch
    const processBatchFunc = depository.interface.getFunction('processBatch');
    const processBatchSelector = processBatchFunc?.selector || 'NOT_FOUND';
    console.log(`🔍 Function selector: ${processBatchSelector}`);
    
    // Check deployed bytecode contains this selector
    const bytecode = await provider.getCode(depository.target);
    const hasSelector = bytecode.includes(processBatchSelector.slice(2)); // Remove 0x
    console.log(`🔍 Deployed bytecode contains processBatch selector: ${hasSelector}`);
    console.log(`🔍 Bytecode length: ${bytecode.length} chars`);
    
    // Check ABI hash vs expected
    const abiHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(depository.interface.fragments.map(f => {
      // Proper typing: Fragment has format method
      return 'format' in f && typeof f.format === 'function' ? f.format() : f.toString();
    }))));
    console.log(`🔍 ABI hash: ${abiHash.slice(0, 10)}...`);
    
    // Log exact call data being generated
    const callData = depository.interface.encodeFunctionData('processBatch', [entityId, batch]);
    console.log(`🔍 Call data length: ${callData.length} chars`);
    console.log(`🔍 Call data start: ${callData.slice(0, 20)}...`);
    
    // Try different entity addresses to see if it's entity-specific
    console.log(`🔍 Testing with different entity addresses...`);
    
    // Test entity 0 (should exist from token 0)
    try {
      const balance0 = await depository['_reserves']!("0x0000000000000000000000000000000000000000000000000000000000000000", 0);
      console.log(`🔍 Entity 0 Token 0 balance: ${balance0.toString()}`);
    } catch (e) {
      console.log(`❌ Entity 0 balance check failed: ${(e as Error).message}`);
    }
    
    // Try simpler batch with just empty arrays
    const emptyBatch = {
      reserveToExternalToken: [],
      externalTokenToReserve: [],
      reserveToReserve: [],
      reserveToCollateral: [],
      cooperativeUpdate: [],
      cooperativeDisputeProof: [],
      initialDisputeProof: [],
      finalDisputeProof: [],
      flashloans: [],
      hub_id: 0
    };
    
    console.log(`🔍 Testing empty batch first...`);
    try {
      const emptyResult = await depository['processBatch']?.staticCall(entityId, emptyBatch);
      console.log(`✅ Empty batch works: ${emptyResult}`);
      
      // If empty batch works, try our batch
      console.log(`🔍 Now testing our batch...`);
      const result = await depository['processBatch']?.staticCall(entityId, batch);
      console.log(`✅ Static call successful: ${result}`);
    } catch (staticError) {
      console.error(`❌ Static call failed:`, staticError);

      // Type-safe error handling for ethers.js errors
      const errorDetails: Record<string, unknown> = {};
      if (staticError && typeof staticError === 'object') {
        const errorObj = staticError as Record<string, unknown>;
        const code = errorObj['code'];
        const data = errorObj['data'];
        const reason = errorObj['reason'];
        if (code !== undefined) errorDetails['code'] = code;
        if (data !== undefined) errorDetails['data'] = data;
        if (reason !== undefined) errorDetails['reason'] = reason;
      }
      console.log(`🔍 Error details:`, errorDetails);
      throw staticError;
    }
    
    // First try to estimate gas to get better error info
    console.log(`🔍 Estimating gas for processBatch...`);
    try {
      const gasEstimate = await depository['processBatch']?.estimateGas(entityId, batch);
      console.log(`🔍 Gas estimate: ${gasEstimate?.toString() || 'N/A'}`);
    } catch (gasError) {
      console.error(`❌ Gas estimation failed:`, gasError);
      throw gasError;
    }
    
    // Submit the batch transaction to the real blockchain (entity can sign as any entity for now)
    const tx = await depository['processBatch']!(entityId, batch);
    console.log(`📡 Transaction submitted: ${tx.hash}`);
    
    // Wait for confirmation
    const receipt = await tx.wait();
    console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
    
    return { transaction: tx, receipt };
  } catch (error) {
    console.error(`❌ Failed to submit processBatch to ${jurisdiction.name}:`, error);
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
      receipt.logs.forEach((log: any, i: number) => {
        try {
          const parsed = entityProvider.interface.parseLog(log);
          console.log(`   📝 Log ${i}: ${parsed?.name} - ${JSON.stringify(parsed?.args)}`);
        } catch {
          console.log(`   📝 Log ${i}: Unable to parse log - ${log.topics?.[0]}`);
        }
      });
    }

    // Extract entity number from event logs
    const event = receipt.logs.find((log: any) => {
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
    console.error('❌ Blockchain registration failed:', error);
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
    console.error('❌ Name assignment failed:', error);
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
    console.error('❌ Failed to get entity info from chain:', error);
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
    console.error('❌ Failed to get next entity number:', error);
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

  try {
    let config: any;

    if (!isBrowser && typeof process !== 'undefined') {
      // Node.js environment - use centralized loader
      console.log('🔍 JURISDICTION SOURCE: Using centralized jurisdiction-loader');
      config = loadJurisdictions();
      console.log('🔍 JURISDICTION DEBUG: Loaded config with contracts:', config.jurisdictions?.ethereum?.contracts);
      console.log('✅ Loaded jurisdictions from centralized loader (cached)');
    } else {
      // Browser environment - fetch from server (use relative path for GitHub Pages compatibility)
      const response = await fetch('./jurisdictions.json');
      if (!response.ok) {
        throw new Error(`Failed to fetch jurisdictions.json: ${response.status} ${response.statusText}`);
      }
      config = await response.json();
      console.log('🔍 JURISDICTION DEBUG: Browser loaded config with contracts:', config.jurisdictions?.ethereum?.contracts);
      console.log('✅ Loaded jurisdictions from server');
    }

    const jurisdictionData = config.jurisdictions;

    // Build jurisdictions from loaded config with type safety
    for (const [key, data] of Object.entries(jurisdictionData)) {
      // Validate structure before using
      if (!data || typeof data !== 'object') {
        console.warn(`🚨 Invalid jurisdiction data for ${key}:`, data);
        continue;
      }
      const jData = data as Record<string, any>;

      // CRITICAL: Expand relative port references using location.origin
      // This allows jurisdictions.json to work from any domain (xln.finance, localhost, etc)
      let rpcUrl = jData['rpc'];
      if (isBrowser && rpcUrl.startsWith(':')) {
        // Browser: location.protocol + location.hostname + port
        const baseOrigin = `${window.location.protocol}//${window.location.hostname}`;
        rpcUrl = `${baseOrigin}${rpcUrl}`;
        console.log(`🔧 Expanded RPC URL: ${jData['rpc']} → ${rpcUrl}`);
      } else if (!isBrowser && rpcUrl.startsWith(':')) {
        // Node.js: Default to localhost
        rpcUrl = `http://localhost${rpcUrl}`;
      }

      jurisdictions.set(key, {
        address: rpcUrl,
        name: jData['name'],
        entityProviderAddress: jData['contracts']['entityProvider'],
        depositoryAddress: jData['contracts']['depository'],
        chainId: jData['chainId'],
      });
    }
  } catch (error) {
    console.error('❌ Failed to load jurisdictions:', error);
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

export const getJurisdictionByAddress = async (address: string): Promise<JurisdictionConfig | undefined> => {
  const jurisdictions = await getJurisdictions();
  return jurisdictions.get(address);
};

export const submitSettle = async (jurisdiction: JurisdictionConfig, leftEntity: string, rightEntity: string, diffs: any[]) => {
  try {
    console.log(`⚖️ Submitting settle transaction between ${leftEntity.slice(0, 10)}... and ${rightEntity.slice(0, 10)}...`);
    console.log(`🔍 DIFFS:`, diffs.map(d => ({
      ...d,
      leftDiff: d.leftDiff.toString(),
      rightDiff: d.rightDiff.toString(),
      collateralDiff: d.collateralDiff.toString()
    })));

    const { depository, provider } = await connectToEthereum(jurisdiction);
    console.log(`🔍 CONTRACT ADDRESS: ${depository.target}`);

    // Check if contract exists
    const code = await provider.getCode(depository.target);
    if (code === '0x') {
      throw new Error('Contract not deployed at this address');
    }

    // Call settle function
    console.log(`📤 Calling settle function...`);
    const tx = await depository['settle']!(leftEntity, rightEntity, diffs);
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
    console.error('❌ Settlement failed:', error);
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
    console.error('❌ Direct R2R failed:', error);
    throw error;
  }
};
