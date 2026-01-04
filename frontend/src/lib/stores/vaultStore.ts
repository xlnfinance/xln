import { writable, get, derived } from 'svelte/store';
import { HDNodeWallet, Mnemonic } from 'ethers';

// Types
export interface Signer {
  index: number;
  address: string;
  name: string;
  entityId?: string; // Auto-created entity for this signer
}

export interface Vault {
  id: string; // name = id
  seed: string; // raw 12-word mnemonic
  signers: Signer[];
  activeSignerIndex: number;
  createdAt: number;
}

export interface VaultState {
  vaults: Record<string, Vault>;
  activeVaultId: string | null;
}

// BIP44 derivation path for Ethereum: m/44'/60'/0'/0/index
const ETH_PATH_PREFIX = "m/44'/60'/0'/0/";

// Default state
const defaultState: VaultState = {
  vaults: {},
  activeVaultId: null
};

// Storage key
const VAULT_STORAGE_KEY = 'xln-vaults';

// Main store
export const vaultState = writable<VaultState>(defaultState);

// Derived stores
export const activeVault = derived(vaultState, ($state) => {
  if (!$state.activeVaultId) return null;
  return $state.vaults[$state.activeVaultId] || null;
});

export const activeSigner = derived(activeVault, ($vault) => {
  if (!$vault) return null;
  return $vault.signers[$vault.activeSignerIndex] || null;
});

export const allVaults = derived(vaultState, ($state) => {
  return Object.values($state.vaults).sort((a, b) => b.createdAt - a.createdAt);
});

// HD derivation helper
function deriveAddress(seed: string, index: number): string {
  const mnemonic = Mnemonic.fromPhrase(seed);
  const hdNode = HDNodeWallet.fromMnemonic(mnemonic, ETH_PATH_PREFIX + index);
  return hdNode.address;
}

function derivePrivateKey(seed: string, index: number): string {
  const mnemonic = Mnemonic.fromPhrase(seed);
  const hdNode = HDNodeWallet.fromMnemonic(mnemonic, ETH_PATH_PREFIX + index);
  return hdNode.privateKey;
}

// Vault operations
export const vaultOperations = {
  // Load from localStorage
  loadFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return;

      const saved = localStorage.getItem(VAULT_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        vaultState.set(parsed);
        console.log('🔐 Vaults loaded from localStorage');
      }
    } catch (error) {
      console.error('❌ Failed to load vaults:', error);
      vaultState.set(defaultState);
    }
  },

  // Save to localStorage
  saveToStorage() {
    try {
      if (typeof localStorage === 'undefined') return;

      const current = get(vaultState);
      localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(current));
      console.log('💾 Vaults saved to localStorage');
    } catch (error) {
      console.error('❌ Failed to save vaults:', error);
    }
  },

  // Create new vault from seed
  createVault(name: string, seed: string): Vault {
    const id = name; // name = id

    // Derive first signer (index 0)
    const firstAddress = deriveAddress(seed, 0);

    const vault: Vault = {
      id,
      seed,
      signers: [{
        index: 0,
        address: firstAddress,
        name: 'Signer 1'
      }],
      activeSignerIndex: 0,
      createdAt: Date.now()
    };

    vaultState.update(state => ({
      ...state,
      vaults: {
        ...state.vaults,
        [id]: vault
      },
      activeVaultId: id
    }));

    this.saveToStorage();
    return vault;
  },

  // Select vault
  selectVault(vaultId: string) {
    vaultState.update(state => ({
      ...state,
      activeVaultId: vaultId
    }));
    this.saveToStorage();
  },

  // Add signer to active vault
  addSigner(name?: string): Signer | null {
    const current = get(vaultState);
    if (!current.activeVaultId) return null;

    const vault = current.vaults[current.activeVaultId];
    if (!vault) return null;

    const nextIndex = vault.signers.length;
    const address = deriveAddress(vault.seed, nextIndex);

    const newSigner: Signer = {
      index: nextIndex,
      address,
      name: name || `Signer ${nextIndex + 1}`
    };

    vaultState.update(state => ({
      ...state,
      vaults: {
        ...state.vaults,
        [vault.id]: {
          ...vault,
          signers: [...vault.signers, newSigner]
        }
      }
    }));

    this.saveToStorage();

    // Auto-create ephemeral entity for this signer (async, non-blocking)
    import('../utils/entityFactory').then(({ autoCreateEntityForSigner }) => {
      autoCreateEntityForSigner(address).then(entityId => {
        if (entityId) {
          this.setSignerEntity(nextIndex, entityId);
          console.log(`[VaultStore] Auto-created entity ${entityId.slice(0, 10)} for signer ${address.slice(0, 10)}`);
        }
      }).catch(err => {
        console.warn('[VaultStore] Failed to auto-create entity:', err);
      });
    });

    return newSigner;
  },

  // Select signer
  selectSigner(index: number) {
    const current = get(vaultState);
    if (!current.activeVaultId) return;

    const vault = current.vaults[current.activeVaultId];
    if (!vault || index >= vault.signers.length) return;

    vaultState.update(state => ({
      ...state,
      vaults: {
        ...state.vaults,
        [vault.id]: {
          ...vault,
          activeSignerIndex: index
        }
      }
    }));

    this.saveToStorage();
  },

  // Rename signer
  renameSigner(index: number, name: string) {
    const current = get(vaultState);
    if (!current.activeVaultId) return;

    const vault = current.vaults[current.activeVaultId];
    if (!vault || index >= vault.signers.length) return;

    vaultState.update(state => ({
      ...state,
      vaults: {
        ...state.vaults,
        [vault.id]: {
          ...vault,
          signers: vault.signers.map((s, i) =>
            i === index ? { ...s, name } : s
          )
        }
      }
    }));

    this.saveToStorage();
  },

  // Set entity ID for signer
  setSignerEntity(signerIndex: number, entityId: string) {
    const current = get(vaultState);
    if (!current.activeVaultId) return;

    const vault = current.vaults[current.activeVaultId];
    if (!vault || signerIndex >= vault.signers.length) return;

    vaultState.update(state => ({
      ...state,
      vaults: {
        ...state.vaults,
        [vault.id]: {
          ...vault,
          signers: vault.signers.map((s, i) =>
            i === signerIndex ? { ...s, entityId } : s
          )
        }
      }
    }));

    this.saveToStorage();
  },

  // Delete vault
  deleteVault(vaultId: string) {
    vaultState.update(state => {
      const { [vaultId]: removed, ...remaining } = state.vaults;
      const remainingIds = Object.keys(remaining);

      return {
        vaults: remaining,
        activeVaultId: state.activeVaultId === vaultId
          ? (remainingIds[0] || null)
          : state.activeVaultId
      };
    });

    this.saveToStorage();
  },

  // Get private key for active signer
  getActiveSignerPrivateKey(): string | null {
    const current = get(vaultState);
    if (!current.activeVaultId) return null;

    const vault = current.vaults[current.activeVaultId];
    if (!vault) return null;

    return derivePrivateKey(vault.seed, vault.activeSignerIndex);
  },

  // Get private key for specific signer
  getSignerPrivateKey(signerIndex: number): string | null {
    const current = get(vaultState);
    if (!current.activeVaultId) return null;

    const vault = current.vaults[current.activeVaultId];
    if (!vault || signerIndex >= vault.signers.length) return null;

    return derivePrivateKey(vault.seed, signerIndex);
  },

  // Check if vault exists
  vaultExists(id: string): boolean {
    const current = get(vaultState);
    return id in current.vaults;
  },

  // Initialize
  initialize() {
    this.loadFromStorage();
  },

  // Clear all vaults
  clearAll() {
    vaultState.set(defaultState);
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(VAULT_STORAGE_KEY);
    }
  }
};
