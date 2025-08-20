// Jurisdiction Service - J-Machine Integration
// Handles connection to 3 hardhat nodes and EntityProvider.sol contracts

import { writable, derived, get } from 'svelte/store';
import { ethers } from 'ethers';

// Types for jurisdiction management
export interface JurisdictionConfig {
  name: string;
  chainId: number;
  rpc: string;
  contracts: {
    entityProvider: string;
    depository: string;
  };
  explorer: string;
  currency: string;
  status: 'active' | 'inactive' | 'error';
}

export interface JurisdictionStatus {
  name: string;
  connected: boolean;
  blockHeight: number;
  lastUpdate: number;
  error?: string;
  provider?: ethers.JsonRpcProvider;
  entityProviderContract?: ethers.Contract;
  depositoryContract?: ethers.Contract;
}

export interface EntityShareInfo {
  entityId: string;
  entityNumber: number;
  cShares: bigint;
  dShares: bigint;
  totalCShares: bigint;
  totalDShares: bigint;
  boardHash: string;
  jurisdiction: string;
}

// EntityProvider.sol ABI (simplified for key functions)
const ENTITY_PROVIDER_ABI = [
  "function registerNumberedEntity(bytes32 boardHash) external returns (uint256 entityNumber)",
  "function getEntityInfo(bytes32 entityId) external view returns (bool exists, bytes32 currentBoardHash, bytes32 proposedBoardHash, uint256 registrationBlock, string memory name)",
  "function nextNumber() external view returns (uint256)",
  "function getTokenIds(uint256 entityNumber) external pure returns (uint256 controlTokenId, uint256 dividendTokenId)",
  "function getGovernanceInfo(uint256 entityNumber) external view returns (uint256 controlSupply, uint256 dividendSupply, bytes32 boardHash)",
  "event EntityRegistered(bytes32 indexed entityId, uint256 indexed entityNumber, bytes32 boardHash)",
  "event GovernanceEnabled(bytes32 indexed entityId, uint256 controlTokenId, uint256 dividendTokenId)"
];

// Depository.sol ABI (simplified)
const DEPOSITORY_ABI = [
  "function deposit(address token, uint256 amount) external",
  "function withdraw(address token, uint256 amount) external",
  "function getBalance(address token, address account) external view returns (uint256)",
  "event Deposit(address indexed token, address indexed account, uint256 amount)",
  "event Withdrawal(address indexed token, address indexed account, uint256 amount)"
];

// Stores
export const jurisdictions = writable<Map<string, JurisdictionStatus>>(new Map());
export const isConnecting = writable<boolean>(false);
export const connectionError = writable<string | null>(null);

// Derived store for connection status
export const allJurisdictionsConnected = derived(
  jurisdictions,
  ($jurisdictions) => {
    const statuses = Array.from($jurisdictions.values());
    return statuses.length === 3 && statuses.every(status => status.connected);
  }
);

// Jurisdiction Service Implementation
class JurisdictionServiceImpl {
  private jurisdictionConfigs: Map<string, JurisdictionConfig> = new Map();
  private eventListeners: Map<string, ethers.Contract> = new Map();

  async initialize() {
    try {
      isConnecting.set(true);
      connectionError.set(null);
      console.log('🏛️ Starting J-Machine initialization...');

      // Load jurisdiction configurations
      await this.loadJurisdictionConfigs();
      console.log('📋 Loaded jurisdiction configurations');

      // Connect to all jurisdictions
      await this.connectToAllJurisdictions();
      console.log('🔗 Connected to all jurisdictions');

      // Set up event listeners
      await this.setupEventListeners();
      console.log('👂 Set up event listeners');

      console.log('🏛️ J-Machine initialized successfully');
      isConnecting.set(false);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to initialize J-Machine';
      connectionError.set(errorMessage);
      isConnecting.set(false);
      console.error('❌ J-Machine initialization failed:', error);
      throw error;
    }
  }

  private async loadJurisdictionConfigs() {
    try {
      console.log('📡 Fetching jurisdiction configurations from /jurisdictions.json...');
      // In browser environment, we'll use the jurisdictions.json data
      // In production, this would be loaded from the server
      const response = await fetch('/jurisdictions.json');
      console.log('📡 Response status:', response.status, response.statusText);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch jurisdictions.json: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      console.log('📋 Fetched data:', data);
      
      for (const [key, config] of Object.entries(data.jurisdictions)) {
        this.jurisdictionConfigs.set(key, config as JurisdictionConfig);
        console.log(`📋 Loaded jurisdiction: ${key}`, config);
      }

      console.log('📋 Loaded jurisdiction configurations:', this.jurisdictionConfigs.size);
    } catch (error) {
      console.error('❌ Failed to load jurisdiction configs:', error);
      throw error;
    }
  }

  private async connectToAllJurisdictions() {
    const statusMap = new Map<string, JurisdictionStatus>();

    for (const [name, config] of this.jurisdictionConfigs) {
      console.log(`🔌 Attempting to connect to ${config.name} (${config.rpc})...`);
      try {
        const status = await this.connectToJurisdiction(name, config);
        statusMap.set(name, status);
        console.log(`✅ Connected to ${config.name} (${config.rpc})`);
      } catch (error) {
        const errorStatus: JurisdictionStatus = {
          name: config.name,
          connected: false,
          blockHeight: 0,
          lastUpdate: Date.now(),
          error: error instanceof Error ? error.message : 'Connection failed'
        };
        statusMap.set(name, errorStatus);
        console.error(`❌ Failed to connect to ${config.name}:`, error);
        
        // For now, let's still add disconnected jurisdictions to the map so they show up in the dropdown
        console.log(`➕ Adding disconnected jurisdiction ${config.name} to map for dropdown display`);
      }
    }

    jurisdictions.set(statusMap);
    console.log(`🗺️ Final jurisdiction map size: ${statusMap.size}`);
  }

  private async connectToJurisdiction(name: string, config: JurisdictionConfig): Promise<JurisdictionStatus> {
    // Create provider
    const provider = new ethers.JsonRpcProvider(config.rpc);
    
    // Test connection
    const blockNumber = await provider.getBlockNumber();
    
    // Create contract instances
    const entityProviderContract = new ethers.Contract(
      config.contracts.entityProvider,
      ENTITY_PROVIDER_ABI,
      provider
    );

    const depositoryContract = new ethers.Contract(
      config.contracts.depository,
      DEPOSITORY_ABI,
      provider
    );

    // Test contract calls
    try {
      const nextNumber = await entityProviderContract.nextNumber();
      console.log(`✅ ${config.name}: Connected to EntityProvider contract, next entity number: ${nextNumber}`);
    } catch (error) {
      console.error(`❌ EntityProvider contract not responding on ${config.name}:`, error);
      throw new Error(`Failed to connect to EntityProvider contract on ${config.name}`);
    }

    return {
      name: config.name,
      connected: true,
      blockHeight: blockNumber,
      lastUpdate: Date.now(),
      provider,
      entityProviderContract,
      depositoryContract
    };
  }

  private async setupEventListeners() {
    const $jurisdictions = get(jurisdictions);

    for (const [name, status] of $jurisdictions) {
      if (status.connected && status.entityProviderContract) {
        // Listen for EntityRegistered events
        status.entityProviderContract.on('EntityRegistered', (entityId, entityNumber, boardHash, event) => {
          console.log(`🏗️ Entity registered on ${name}:`, {
            entityId,
            entityNumber: entityNumber.toString(),
            boardHash,
            jurisdiction: name
          });
          this.handleEntityCreated(name, entityNumber, boardHash, event);
        });

        // Listen for GovernanceEnabled events
        status.entityProviderContract.on('GovernanceEnabled', (entityId, controlTokenId, dividendTokenId, event) => {
          console.log(`🎯 Governance enabled on ${name}:`, {
            entityId,
            controlTokenId: controlTokenId.toString(),
            dividendTokenId: dividendTokenId.toString(),
            jurisdiction: name
          });
          this.handleGovernanceEnabled(name, entityId, controlTokenId, dividendTokenId, event);
        });

        this.eventListeners.set(name, status.entityProviderContract);
      }
    }

    console.log('👂 Event listeners set up for all connected jurisdictions');
  }

  // Event handlers for J-Machine → E-Machine propagation
  private async handleEntityCreated(jurisdiction: string, entityNumber: bigint, boardHash: string, event: any) {
    // Create proposal for E-machine consensus
    const proposal = {
      type: 'j_machine_event',
      data: {
        eventType: 'EntityRegistered',
        jurisdiction,
        entityNumber: entityNumber.toString(),
        boardHash,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash
      }
    };

    // This would be sent to the E-machine for consensus
    console.log('📨 Proposing J-machine event to E-machine:', proposal);
    // TODO: Integrate with server.ts to create actual proposals
  }

  private async handleGovernanceEnabled(jurisdiction: string, entityId: string, controlTokenId: bigint, dividendTokenId: bigint, event: any) {
    // Create proposal for E-machine consensus
    const proposal = {
      type: 'j_machine_event',
      data: {
        eventType: 'GovernanceEnabled',
        jurisdiction,
        entityId,
        controlTokenId: controlTokenId.toString(),
        dividendTokenId: dividendTokenId.toString(),
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash
      }
    };

    // This would be sent to the E-machine for consensus
    console.log('📨 Proposing governance event to E-machine:', proposal);
    // TODO: Integrate with server.ts to create actual proposals
  }



  // Public methods for entity operations
  async createEntity(jurisdiction: string, boardHash: string, signerPrivateKey?: string): Promise<{ entityNumber: number; transactionHash: string }> {
    const status = get(jurisdictions).get(jurisdiction);
    if (!status || !status.connected || !status.entityProviderContract) {
      throw new Error(`Not connected to jurisdiction: ${jurisdiction}`);
    }

    try {
      console.log(`🏗️ Creating entity on ${jurisdiction} with board hash: ${boardHash}`);
      
      // Create entity on the blockchain
      const tx = await status.entityProviderContract.registerNumberedEntity(boardHash);
      const receipt = await tx.wait();
      
      // Get the entity number from the event
      const event = receipt.logs.find((log: any) => 
        log.eventName === 'EntityRegistered'
      );
      
      if (!event) {
        throw new Error('EntityRegistered event not found in transaction receipt');
      }
      
      const entityNumber = Number(event.args.entityNumber);
      const transactionHash = receipt.hash;
      
      console.log(`✅ Entity created: #${entityNumber} on ${jurisdiction} (tx: ${transactionHash})`);
      
      return {
        entityNumber,
        transactionHash
      };
    } catch (error) {
      console.error(`❌ Failed to create entity on ${jurisdiction}:`, error);
      throw error;
    }
  }

  async getEntityInfo(jurisdiction: string, entityNumber: number): Promise<EntityShareInfo | null> {
    const status = get(jurisdictions).get(jurisdiction);
    if (!status || !status.connected || !status.entityProviderContract) {
      return null;
    }

    try {
      // Get entity info from the blockchain
      const entityId = ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32);
      const [exists, currentBoardHash, proposedBoardHash, registrationBlock, name] = await status.entityProviderContract.getEntityInfo(entityId);
      
      if (!exists) {
        console.log(`Entity #${entityNumber} does not exist on ${jurisdiction}`);
        return null;
      }

      // Get governance info for shares
      const [controlSupply, dividendSupply, boardHash] = await status.entityProviderContract.getGovernanceInfo(entityNumber);
      
      // For now, assume the entity itself owns all shares initially
      // In a real implementation, you'd track individual share ownership
      const entityInfo: EntityShareInfo = {
        entityId: entityId,
        entityNumber,
        cShares: controlSupply,
        dShares: dividendSupply,
        totalCShares: controlSupply,
        totalDShares: dividendSupply,
        boardHash: currentBoardHash,
        jurisdiction
      };

      return entityInfo;
    } catch (error) {
      console.error(`❌ Failed to get entity info for #${entityNumber} on ${jurisdiction}:`, error);
      return null;
    }
  }

  async refreshJurisdictionStatus() {
    await this.connectToAllJurisdictions();
  }

  disconnect() {
    // Clean up event listeners
    for (const [name, contract] of this.eventListeners) {
      contract.removeAllListeners();
    }
    this.eventListeners.clear();

    // Reset stores
    jurisdictions.set(new Map());
    isConnecting.set(false);
    connectionError.set(null);

    console.log('🔌 Disconnected from all jurisdictions');
  }
}

// Export singleton instance
export const jurisdictionService = new JurisdictionServiceImpl();

// Utility functions
export function formatShares(shares: bigint): string {
  const trillion = BigInt(1000000000000);
  const quadrillion = BigInt(1000000000000000);
  
  if (shares >= quadrillion) {
    return `${(shares / trillion).toString()}T`;
  } else if (shares >= trillion) {
    return `${(shares / BigInt(1000000000)).toString()}B`;
  } else {
    return shares.toString();
  }
}

export function calculateOwnershipPercentage(owned: bigint, total: bigint): number {
  if (total === BigInt(0)) return 0;
  return Number((owned * BigInt(10000)) / total) / 100; // 2 decimal places
}

export function formatEntityId(entityNumber: number): string {
  return `#${entityNumber}`;
}
