// === JURISDICTION MANAGEMENT ===
const isBrowser = typeof window !== 'undefined';
// Load contract configuration and generate jurisdictions
export const generateJurisdictions = () => {
    const jurisdictions = new Map();
    // For browser, return empty map - jurisdictions will be populated dynamically
    if (isBrowser) {
        console.log('🌐 Browser detected - jurisdictions will be loaded dynamically');
        return jurisdictions;
    }
    // Node.js environment - load from file
    let networks;
    try {
        const fs = require('fs');
        const path = require('path');
        const configPath = path.join(process.cwd(), 'contract-addresses.json');
        const configData = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configData);
        console.log('✅ Loaded contract addresses from config file');
        networks = config.networks;
    }
    catch (error) {
        console.error('❌ CRITICAL: Could not load contract-addresses.json');
        console.error('   Please run: ./deploy-contracts.sh');
        throw new Error('Contract addresses configuration file not found or invalid');
    }
    if (networks['8545']) {
        const network = networks['8545'];
        if (!network.entityProvider) {
            throw new Error('Missing entityProvider address for Ethereum network (8545)');
        }
        jurisdictions.set('ethereum', {
            address: network.rpc,
            name: network.name,
            entityProviderAddress: network.entityProvider,
            depositoryAddress: network.depository,
            chainId: network.chainId
        });
    }
    if (networks['8546']) {
        const network = networks['8546'];
        if (!network.entityProvider) {
            throw new Error('Missing entityProvider address for Polygon network (8546)');
        }
        jurisdictions.set('polygon', {
            address: network.rpc,
            name: network.name,
            entityProviderAddress: network.entityProvider,
            depositoryAddress: network.depository,
            chainId: network.chainId
        });
    }
    if (networks['8547']) {
        const network = networks['8547'];
        if (!network.entityProvider) {
            throw new Error('Missing entityProvider address for Arbitrum network (8547)');
        }
        jurisdictions.set('arbitrum', {
            address: network.rpc,
            name: network.name,
            entityProviderAddress: network.entityProvider,
            depositoryAddress: network.depository,
            chainId: network.chainId
        });
    }
    return jurisdictions;
};
export const DEFAULT_JURISDICTIONS = generateJurisdictions();
export const getAvailableJurisdictions = () => {
    return Array.from(DEFAULT_JURISDICTIONS.values());
};
export const getJurisdictionByAddress = (address) => {
    return DEFAULT_JURISDICTIONS.get(address);
};
export const registerEntityInJurisdiction = async (entityId, config, jurisdiction) => {
    try {
        const DEBUG = true;
        if (DEBUG) {
            console.log(`🏛️  Registering entity "${entityId}" in jurisdiction "${jurisdiction.name}"`);
            console.log(`    EntityProvider: ${jurisdiction.entityProviderAddress}`);
            console.log(`    Validators: ${config.validators.join(', ')}`);
            console.log(`    Threshold: ${config.threshold}/${Object.values(config.shares).reduce((a, b) => a + b, 0n)}`);
        }
        // For demo purposes, simulate successful registration
        // In production, this would make actual contract calls
        const mockTxHash = `0x${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
        if (DEBUG) {
            console.log(`✅ Entity registration simulated successfully`);
            console.log(`    Transaction Hash: ${mockTxHash}`);
            console.log(`    Entity can now interact with jurisdiction contracts`);
        }
        return {
            success: true,
            transactionHash: mockTxHash
        };
    }
    catch (error) {
        const DEBUG = true;
        if (DEBUG) {
            console.error(`❌ Entity registration failed:`, error);
        }
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
};
