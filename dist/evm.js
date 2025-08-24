/**
 * XLN EVM Integration
 * Handles blockchain interactions, jurisdictions, and smart contract operations
 */
import { ethers } from 'ethers';
import path from 'path';
import fs from 'fs';
import { DEBUG, isBrowser } from './utils.js';
import { encodeBoard, hashBoard, detectEntityType, extractNumberFromEntityId } from './entity-factory.js';
// === ETHEREUM INTEGRATION ===
// Load contract configuration directly in jurisdiction generation
export const ENTITY_PROVIDER_ABI = [
    "function registerNumberedEntity(bytes32 boardHash) external returns (uint256 entityNumber)",
    "function assignName(string memory name, uint256 entityNumber) external",
    "function transferName(string memory name, uint256 newEntityNumber) external",
    "function entities(bytes32 entityId) external view returns (tuple(uint256 boardHash, uint8 status, uint256 activationTime))",
    "function nameToNumber(string memory name) external view returns (uint256)",
    "function numberToName(uint256 entityNumber) external view returns (string memory)",
    "function nextNumber() external view returns (uint256)",
    // Governance functions (governance is auto-setup on entity registration)
    "function getTokenIds(uint256 entityNumber) external pure returns (uint256 controlTokenId, uint256 dividendTokenId)",
    "function getGovernanceInfo(uint256 entityNumber) external view returns (uint256 controlTokenId, uint256 dividendTokenId, uint256 controlSupply, uint256 dividendSupply, bool hasActiveProposal, bytes32 articlesHash)",
    "function balanceOf(address account, uint256 id) external view returns (uint256)",
    "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data) external",
    // Events
    "event EntityRegistered(bytes32 indexed entityId, uint256 indexed entityNumber, bytes32 boardHash)",
    "event NameAssigned(string indexed name, uint256 indexed entityNumber)",
    "event NameTransferred(string indexed name, uint256 indexed oldEntityNumber, uint256 indexed newEntityNumber)",
    "event GovernanceEnabled(bytes32 indexed entityId, uint256 controlTokenId, uint256 dividendTokenId)"
];
export const connectToEthereum = async (jurisdiction) => {
    try {
        // Connect to specified RPC node
        const provider = new ethers.JsonRpcProvider(jurisdiction.address);
        // Use first account for testing (Hardhat account #0)
        const signer = await provider.getSigner(0);
        // Create contract instances
        const entityProvider = new ethers.Contract(jurisdiction.entityProviderAddress, ENTITY_PROVIDER_ABI, signer);
        const depository = new ethers.Contract(jurisdiction.depositoryAddress, [], signer); // Add depository ABI later if needed
        return { provider, signer, entityProvider, depository };
    }
    catch (error) {
        console.error(`Failed to connect to ${jurisdiction.name} at ${jurisdiction.address}:`, error);
        throw error;
    }
};
// Note: setupGovernance is no longer needed - governance is automatically created on entity registration
export const registerNumberedEntityOnChain = async (config, name) => {
    if (!config.jurisdiction) {
        throw new Error("Jurisdiction required for on-chain registration");
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
            // Browser environment - fetch from server (use root path so it works under /ui/* routes)
            const response = await fetch('/jurisdictions.json');
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
                chainId: jData.chainId
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
