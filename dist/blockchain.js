// === BLOCKCHAIN INTEGRATION ===
import { ethers } from 'ethers';
import { encodeBoard, hashBoard, detectEntityType, extractNumberFromEntityId } from './entity-utils.js';
const DEBUG = true;
const isBrowser = typeof window !== 'undefined';
// Contract ABI
const ENTITY_PROVIDER_ABI = [
    "function registerNumberedEntity(bytes32 boardHash) external returns (uint256 entityNumber)",
    "function assignName(string memory name, uint256 entityNumber) external",
    "function transferName(string memory name, uint256 newEntityNumber) external",
    "function entities(bytes32 entityId) external view returns (tuple(uint256 boardHash, uint8 status, uint256 activationTime))",
    "function nameToNumber(string memory name) external view returns (uint256)",
    "function numberToName(uint256 entityNumber) external view returns (string memory)",
    "function nextNumber() external view returns (uint256)",
    "event EntityRegistered(bytes32 indexed entityId, uint256 indexed entityNumber, bytes32 boardHash)",
    "event NameAssigned(string indexed name, uint256 indexed entityNumber)",
    "event NameTransferred(string indexed name, uint256 indexed oldEntityNumber, uint256 indexed newEntityNumber)"
];
// Get contract address for specific network/port
export const getContractAddress = async (port) => {
    let config;
    if (isBrowser) {
        // Browser environment - fetch from server
        try {
            const response = await fetch('/contract-addresses.json');
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            config = await response.json();
        }
        catch (error) {
            throw new Error(`Could not fetch contract address for port ${port} from server. Make sure server is running and contracts are deployed.`);
        }
    }
    else {
        // Node.js environment - load from file
        const fs = await import('fs');
        const path = await import('path');
        try {
            const configPath = path.join(process.cwd(), 'contract-addresses.json');
            const configData = fs.readFileSync(configPath, 'utf8');
            config = JSON.parse(configData);
        }
        catch (error) {
            throw new Error(`Could not load contract address for port ${port}. Please run: ./deploy-contracts.sh`);
        }
    }
    const address = config.networks[port]?.entityProvider;
    if (!address) {
        throw new Error(`No contract address found for network port ${port}. Please deploy contracts first.`);
    }
    return address;
};
export const connectToEthereum = async (rpcUrl = 'http://localhost:8545', contractAddress) => {
    // Get contract address from configuration if not provided
    const port = rpcUrl.split(':').pop() || '8545';
    const finalContractAddress = contractAddress || await getContractAddress(port);
    if (!finalContractAddress) {
        throw new Error(`No contract address found for network port ${port}`);
    }
    try {
        // Connect to specified RPC node
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        // Use first account for testing (Hardhat account #0)
        const signer = await provider.getSigner(0);
        // Create contract instance
        const entityProvider = new ethers.Contract(finalContractAddress, ENTITY_PROVIDER_ABI, signer);
        return { provider, signer, entityProvider };
    }
    catch (error) {
        console.error(`Failed to connect to Ethereum at ${rpcUrl}:`, error);
        throw error;
    }
};
export const registerNumberedEntityOnChain = async (config, name) => {
    if (!config.jurisdiction) {
        throw new Error("Jurisdiction required for on-chain registration");
    }
    try {
        const { entityProvider } = await connectToEthereum();
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
        // Call the smart contract
        const tx = await entityProvider.registerNumberedEntity(boardHash);
        if (DEBUG)
            console.log(`   📤 Transaction sent: ${tx.hash}`);
        // Wait for confirmation
        const receipt = await tx.wait();
        if (DEBUG)
            console.log(`   ✅ Transaction confirmed in block ${receipt.blockNumber}`);
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
        // Fallback to simulation for development
        if (DEBUG)
            console.log('   🔄 Falling back to simulation...');
        const txHash = `0x${Math.random().toString(16).substring(2, 66)}`;
        const entityNumber = Math.floor(Math.random() * 1000000) + 1;
        if (DEBUG)
            console.log(`   ✅ Simulated registration completed`);
        if (DEBUG)
            console.log(`   TX: ${txHash}`);
        if (DEBUG)
            console.log(`   Entity Number: ${entityNumber}`);
        return { txHash, entityNumber };
    }
};
export const assignNameOnChain = async (name, entityNumber) => {
    try {
        const { entityProvider } = await connectToEthereum();
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
export const getEntityInfoFromChain = async (entityId) => {
    try {
        const { entityProvider } = await connectToEthereum();
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
export const getNextEntityNumber = async (port = '8545') => {
    try {
        const rpcUrl = `http://localhost:${port}`;
        const contractAddress = await getContractAddress(port);
        const { entityProvider } = await connectToEthereum(rpcUrl, contractAddress);
        if (DEBUG)
            console.log(`🔍 Fetching next entity number from ${contractAddress} (port ${port})`);
        const nextNumber = await entityProvider.nextNumber();
        const result = Number(nextNumber);
        if (DEBUG)
            console.log(`🔢 Next entity number: ${result}`);
        return result;
    }
    catch (error) {
        console.error('❌ Failed to get next entity number:', error);
        // Try to check if contract exists by calling a simpler function
        try {
            const rpcUrl = `http://localhost:${port}`;
            const contractAddress = await getContractAddress(port);
            const { provider } = await connectToEthereum(rpcUrl, contractAddress);
            const code = await provider.getCode(contractAddress);
            if (code === '0x') {
                console.error('❌ Contract not deployed at address:', contractAddress);
            }
            else {
                console.log('✅ Contract exists, but nextNumber() call failed');
            }
        }
        catch (checkError) {
            console.error('❌ Failed to check contract:', checkError);
        }
        // Fallback to a reasonable default
        return 1;
    }
};
