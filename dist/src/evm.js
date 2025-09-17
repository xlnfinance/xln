/**
 * XLN EVM Integration
 * Handles blockchain interactions, jurisdictions, and smart contract operations
 */
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { detectEntityType, encodeBoard, extractNumberFromEntityId, hashBoard } from './entity-factory';
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
    'function processBatch(bytes32 entity, tuple(tuple(uint256 tokenId, uint256 amount)[] reserveToExternalToken, tuple(bytes32 entity, uint256 externalTokenId, uint256 internalTokenId, uint256 amount)[] externalTokenToReserve, tuple(bytes32 receivingEntity, uint256 tokenId, uint256 amount)[] reserveToReserve, tuple(bytes32 counterentity, uint256 tokenId, uint256 amount)[] reserveToCollateral, tuple(bytes32 counterentity, tuple(uint256 tokenId, int256 peerReserveDiff, int256 collateralDiff, int256 ondeltaDiff)[] diffs, uint256[] forgiveDebtsInTokenIds, bytes sig)[] cooperativeUpdate, tuple(bytes32 counterentity, tuple(uint256[] offdeltas, uint256[] tokenIds, tuple(address subcontractProviderAddress, bytes encodedBatch, tuple(uint256 deltaIndex, uint256 rightAllowence, uint256 leftAllowence)[] allowences)[] subcontracts) proofbody, bytes initialArguments, bytes finalArguments, bytes sig)[] cooperativeDisputeProof, tuple(bytes32 counterentity, uint256 cooperativeNonce, uint256 disputeNonce, bytes32 proofbodyHash, bytes initialArguments)[] initialDisputeProof, tuple(bytes32 counterentity, uint256 cooperativeNonce, uint256 initialDisputeNonce, uint256 finalDisputeNonce, bool startedByLeft, uint256 disputeUntilBlock, bytes32 initialProofbodyHash, tuple(uint256[] offdeltas, uint256[] tokenIds, tuple(address subcontractProviderAddress, bytes encodedBatch, tuple(uint256 deltaIndex, uint256 rightAllowence, uint256 leftAllowence)[] allowences)[] subcontracts) finalProofbody, bytes initialArguments, bytes finalArguments, bytes sig)[] finalDisputeProof, tuple(uint256 tokenId, uint256 amount)[] flashloans, uint256 hub_id) batch) external returns (bool)',
    'function _reserves(bytes32 entity, uint256 tokenId) external view returns (uint256)',
    'event ReserveUpdated(bytes32 indexed entity, uint256 indexed tokenId, uint256 newBalance)',
    'event ReserveTransferred(bytes32 indexed from, bytes32 indexed to, uint256 indexed tokenId, uint256 amount)',
];
export const connectToEthereum = async (jurisdiction) => {
    try {
        // Connect to specified RPC node
        const provider = new ethers.JsonRpcProvider(jurisdiction.address);
        // Use first account for testing (Hardhat account #0)
        const signer = await provider.getSigner(0);
        // Create contract instances
        const entityProvider = new ethers.Contract(jurisdiction.entityProviderAddress, ENTITY_PROVIDER_ABI, signer);
        const depository = new ethers.Contract(jurisdiction.depositoryAddress, DEPOSITORY_ABI, signer);
        return { provider, signer, entityProvider, depository };
    }
    catch (error) {
        console.error(`Failed to connect to ${jurisdiction.name} at ${jurisdiction.address}:`, error);
        throw error;
    }
};
// Debug function to fund entity reserves for testing
export const debugFundReserves = async (jurisdiction, entityId, tokenId, amount) => {
    try {
        console.log(`💰 DEBUG: Funding entity ${entityId.slice(0, 10)} with ${amount} of token ${tokenId}...`);
        const { depository } = await connectToEthereum(jurisdiction);
        // Fund the entity's reserves for testing
        const tx = await depository.debugFundReserves(entityId, tokenId, amount);
        console.log(`📡 Debug funding transaction: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`✅ Debug funding confirmed in block ${receipt.blockNumber}`);
        // Check new balance
        const newBalance = await depository._reserves(entityId, tokenId);
        console.log(`💰 Entity ${entityId.slice(0, 10)} now has ${newBalance.toString()} of token ${tokenId}`);
        return { transaction: tx, receipt, newBalance };
    }
    catch (error) {
        console.error(`❌ Failed to fund reserves:`, error);
        throw error;
    }
};
// Submit real processBatch transaction to jurisdiction
export const submitProcessBatch = async (jurisdiction, entityId, batch) => {
    try {
        console.log(`💸 Submitting real processBatch to ${jurisdiction.name} as entity ${entityId.slice(0, 10)}...`);
        console.log(`🔍 BATCH DEBUG:`, JSON.stringify(batch, null, 2));
        console.log(`🔍 ENTITY DEBUG: ${entityId}`);
        console.log(`🔍 JURISDICTION DEBUG:`, jurisdiction);
        const { depository, provider } = await connectToEthereum(jurisdiction);
        console.log(`🔍 CONTRACT ADDRESS: ${depository.target}`);
        // Check if contract exists
        const code = await provider.getCode(depository.target);
        console.log(`🔍 CONTRACT CODE LENGTH: ${code.length} characters`);
        if (code === '0x') {
            throw new Error('Contract not deployed at this address');
        }
        // Check current balance (entities should be pre-funded in constructor)
        const currentBalance = await depository._reserves(entityId, batch.reserveToReserve[0]?.tokenId || 1);
        console.log(`🔍 Current balance: ${currentBalance.toString()}`);
        if (currentBalance.toString() === '0') {
            throw new Error(`Entity ${entityId.slice(0, 10)} has no reserves! Contract should be pre-funded.`);
        }
        // First try to estimate gas to get better error info
        console.log(`🔍 Estimating gas for processBatch...`);
        try {
            const gasEstimate = await depository.processBatch.estimateGas(entityId, batch);
            console.log(`🔍 Gas estimate: ${gasEstimate.toString()}`);
        }
        catch (gasError) {
            console.error(`❌ Gas estimation failed:`, gasError);
            throw gasError;
        }
        // Submit the batch transaction to the real blockchain (entity can sign as any entity for now)
        const tx = await depository.processBatch(entityId, batch);
        console.log(`📡 Transaction submitted: ${tx.hash}`);
        // Wait for confirmation
        const receipt = await tx.wait();
        console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
        return { transaction: tx, receipt };
    }
    catch (error) {
        console.error(`❌ Failed to submit processBatch to ${jurisdiction.name}:`, error);
        throw error;
    }
};
// Note: setupGovernance is no longer needed - governance is automatically created on entity registration
export const registerNumberedEntityOnChain = async (config, name) => {
    if (!config.jurisdiction) {
        throw new Error('Jurisdiction required for on-chain registration');
    }
    try {
        const { entityProvider } = await connectToEthereum(config.jurisdiction);
        const encodedBoard = encodeBoard(config);
        const boardHash = hashBoard(encodedBoard);
        if (DEBUG)
            console.log(`🏛️ Registering numbered entity "${name}" on chain`);
        if (DEBUG)
            console.log(`   Jurisdiction: ${config.jurisdiction.name}`);
        if (DEBUG)
            console.log(`   EntityProvider: ${config.jurisdiction.entityProviderAddress}`);
        if (DEBUG)
            console.log(`   Board Hash: ${boardHash}`);
        // Test connection by calling nextNumber()
        try {
            const nextNumber = await entityProvider.nextNumber();
            if (DEBUG)
                console.log(`   📊 Next entity number will be: ${nextNumber}`);
        }
        catch (error) {
            throw new Error(`Failed to call nextNumber(): ${error}`);
        }
        // Call the smart contract
        const tx = await entityProvider.registerNumberedEntity(boardHash);
        if (DEBUG)
            console.log(`   📤 Transaction sent: ${tx.hash}`);
        // Wait for confirmation
        const receipt = await tx.wait();
        if (DEBUG)
            console.log(`   ✅ Transaction confirmed in block ${receipt.blockNumber}`);
        // Check if transaction reverted
        if (receipt.status === 0) {
            throw new Error(`Transaction reverted! Hash: ${tx.hash}`);
        }
        // Debug: log all events in receipt
        if (DEBUG) {
            console.log(`   📋 Receipt logs count: ${receipt.logs.length}`);
            receipt.logs.forEach((log, i) => {
                try {
                    const parsed = entityProvider.interface.parseLog(log);
                    console.log(`   📝 Log ${i}: ${parsed?.name} - ${JSON.stringify(parsed?.args)}`);
                }
                catch {
                    console.log(`   📝 Log ${i}: Unable to parse log - ${log.topics?.[0]}`);
                }
            });
        }
        // Extract entity number from event logs
        const event = receipt.logs.find((log) => {
            try {
                const parsed = entityProvider.interface.parseLog(log);
                return parsed?.name === 'EntityRegistered';
            }
            catch {
                return false;
            }
        });
        if (!event) {
            throw new Error('EntityRegistered event not found in transaction logs');
        }
        const parsedEvent = entityProvider.interface.parseLog(event);
        const entityId = parsedEvent?.args[0];
        const entityNumber = Number(parsedEvent?.args[1]);
        if (DEBUG)
            console.log(`✅ Numbered entity registered!`);
        if (DEBUG)
            console.log(`   TX: ${tx.hash}`);
        if (DEBUG)
            console.log(`   Entity Number: ${entityNumber}`);
        return { txHash: tx.hash, entityNumber };
    }
    catch (error) {
        console.error('❌ Blockchain registration failed:', error);
        throw error;
    }
};
export const assignNameOnChain = async (name, entityNumber, jurisdiction) => {
    try {
        const { entityProvider } = await connectToEthereum(jurisdiction);
        if (DEBUG)
            console.log(`🏷️  Assigning name "${name}" to entity #${entityNumber}`);
        // Call the smart contract (admin only)
        const tx = await entityProvider.assignName(name, entityNumber);
        if (DEBUG)
            console.log(`   📤 Transaction sent: ${tx.hash}`);
        // Wait for confirmation
        const receipt = await tx.wait();
        if (DEBUG)
            console.log(`   ✅ Transaction confirmed in block ${receipt.blockNumber}`);
        // Check if transaction reverted
        if (receipt.status === 0) {
            throw new Error(`Transaction reverted! Hash: ${tx.hash}`);
        }
        if (DEBUG)
            console.log(`✅ Name assigned successfully!`);
        if (DEBUG)
            console.log(`   TX: ${tx.hash}`);
        return { txHash: tx.hash };
    }
    catch (error) {
        console.error('❌ Name assignment failed:', error);
        throw error;
    }
};
export const getEntityInfoFromChain = async (entityId, jurisdiction) => {
    try {
        const { entityProvider } = await connectToEthereum(jurisdiction);
        // Try to get entity info
        const entityInfo = await entityProvider.entities(entityId);
        if (entityInfo.status === 0) {
            return { exists: false };
        }
        // For numbered entities, get the number and name
        const entityType = detectEntityType(entityId);
        let entityNumber;
        let name;
        if (entityType === 'numbered') {
            const extractedNumber = extractNumberFromEntityId(entityId);
            if (extractedNumber !== null) {
                entityNumber = extractedNumber;
                try {
                    const retrievedName = await entityProvider.numberToName(entityNumber);
                    name = retrievedName || undefined;
                }
                catch {
                    // No name assigned
                }
            }
        }
        return { exists: true, entityNumber, name };
    }
    catch (error) {
        console.error('❌ Failed to get entity info from chain:', error);
        return { exists: false };
    }
};
export const getNextEntityNumber = async (jurisdiction) => {
    try {
        if (!jurisdiction) {
            throw new Error('Jurisdiction parameter is required');
        }
        if (!jurisdiction.name || !jurisdiction.address || !jurisdiction.entityProviderAddress) {
            throw new Error('Jurisdiction object is missing required properties (name, address, entityProviderAddress)');
        }
        const { entityProvider } = await connectToEthereum(jurisdiction);
        if (DEBUG)
            console.log(`🔍 Fetching next entity number from ${jurisdiction.entityProviderAddress} (${jurisdiction.name})`);
        const nextNumber = await entityProvider.nextNumber();
        const result = Number(nextNumber);
        if (DEBUG)
            console.log(`🔢 Next entity number: ${result}`);
        return result;
    }
    catch (error) {
        console.error('❌ Failed to get next entity number:', error);
        throw error;
    }
};
export const transferNameBetweenEntities = async (name, fromNumber, toNumber, jurisdiction) => {
    if (DEBUG)
        console.log(`🔄 Transferring name "${name}" from #${fromNumber} to #${toNumber}`);
    // TODO: Implement real blockchain name transfer
    throw new Error('Name transfer not implemented - requires blockchain integration');
};
// === JURISDICTION MANAGEMENT ===
// Load contract configuration and generate jurisdictions
export const generateJurisdictions = async () => {
    const jurisdictions = new Map();
    try {
        let config;
        if (!isBrowser && typeof process !== 'undefined') {
            // Node.js environment - read file directly
            const configPath = path.join(process.cwd(), 'jurisdictions.json');
            const configContent = fs.readFileSync(configPath, 'utf8');
            config = JSON.parse(configContent);
            console.log('✅ Loaded jurisdictions from config file');
        }
        else {
            // Browser environment - fetch from server (use relative path for GitHub Pages compatibility)
            const response = await fetch('./jurisdictions.json');
            if (!response.ok) {
                throw new Error(`Failed to fetch jurisdictions.json: ${response.status} ${response.statusText}`);
            }
            config = await response.json();
            console.log('✅ Loaded jurisdictions from server');
        }
        const jurisdictionData = config.jurisdictions;
        // Build jurisdictions from loaded config
        for (const [key, data] of Object.entries(jurisdictionData)) {
            const jData = data;
            jurisdictions.set(key, {
                address: jData.rpc,
                name: jData.name,
                entityProviderAddress: jData.contracts.entityProvider,
                depositoryAddress: jData.contracts.depository,
                chainId: jData.chainId,
            });
        }
    }
    catch (error) {
        console.error('❌ Failed to load jurisdictions:', error);
    }
    return jurisdictions;
};
export let DEFAULT_JURISDICTIONS = null;
export const getJurisdictions = async () => {
    if (!DEFAULT_JURISDICTIONS) {
        DEFAULT_JURISDICTIONS = await generateJurisdictions();
    }
    return DEFAULT_JURISDICTIONS;
};
export const getAvailableJurisdictions = async () => {
    const jurisdictions = await getJurisdictions();
    return Array.from(jurisdictions.values());
};
export const getJurisdictionByAddress = async (address) => {
    const jurisdictions = await getJurisdictions();
    return jurisdictions.get(address);
};
