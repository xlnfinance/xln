import { writable, get, derived } from 'svelte/store';
import { HDNodeWallet, Mnemonic } from 'ethers';
import { runtimeOperations, runtimes, activeRuntimeId } from './runtimeStore';

// Types
export interface Signer {
  index: number;
  address: string;
  name: string;
  entityId?: string; // Auto-created entity for this signer
}

export interface Runtime {
  id: string; // signer EOA (0xABCD...)
  label: string; // user-chosen name ("MyWallet")
  seed: string; // raw 12-word mnemonic
  signers: Signer[];
  activeSignerIndex: number;
  createdAt: number;
}

export interface RuntimesState {
  runtimes: Record<string, Runtime>;
  activeRuntimeId: string | null;
}

// BIP44 derivation path for Ethereum: m/44'/60'/0'/0/index
const ETH_PATH_PREFIX = "m/44'/60'/0'/0/";

// Default state
const defaultState: RuntimesState = {
  runtimes: {},
  activeRuntimeId: null
};

// Storage key
const VAULT_STORAGE_KEY = 'xln-vaults';

// Main store
export const runtimesState = writable<RuntimesState>(defaultState);

// Derived stores
export const activeRuntime = derived(runtimesState, ($state) => {
  if (!$state.activeRuntimeId) return null;
  return $state.runtimes[$state.activeRuntimeId] || null;
});

export const activeSigner = derived(activeRuntime, ($runtime) => {
  if (!$runtime) return null;
  return $runtime.signers[$runtime.activeSignerIndex] || null;
});

export const allRuntimes = derived(runtimesState, ($state) => {
  return Object.values($state.runtimes).sort((a, b) => b.createdAt - a.createdAt);
});

// Backward compatibility aliases
export const activeVault = activeRuntime;
export const allVaults = allRuntimes;

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

async function fundSignerWalletInBrowserVM(address: string): Promise<void> {
  try {
    const { getXLN } = await import('$lib/stores/xlnStore');
    const xln = await getXLN();
    const browserVM = xln.getBrowserVMInstance?.();
    if (!browserVM?.fundSignerWallet) return;
    await browserVM.fundSignerWallet(address);
  } catch (err) {
    console.warn('[VaultStore] Failed to fund signer wallet:', err);
  }
}

async function fundRuntimeSignersInBrowserVM(runtime: Runtime | null): Promise<void> {
  if (!runtime) return;
  for (const signer of runtime.signers) {
    await fundSignerWalletInBrowserVM(signer.address);
  }
}

  // Runtime operations
  export const vaultOperations = {
    syncRuntime(runtime: Runtime | null) {
    const meta: { label?: string; seed?: string; vaultId?: string } = {};
    meta.label = runtime?.label || 'Runtime';
    if (runtime?.seed) meta.seed = runtime.seed;
    if (runtime?.id) meta.vaultId = runtime.id;

    runtimeOperations.setLocalRuntimeMetadata(meta);

    // REMOVED: setRuntimeSeed() - now passed via env to pure functions
    // All crypto functions read seed from env.runtimeSeed, not global state

    void fundRuntimeSignersInBrowserVM(runtime);
    },

  // Load from localStorage
  loadFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return;

      const saved = localStorage.getItem(VAULT_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        runtimesState.set(parsed);
        console.log('🔐 Runtimes loaded from localStorage');
      }
    } catch (error) {
      console.error('❌ Failed to load runtimes:', error);
      runtimesState.set(defaultState);
    }
  },

  // Save to localStorage
  saveToStorage() {
    try {
      if (typeof localStorage === 'undefined') return;

      const current = get(runtimesState);
      localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(current));
      console.log('💾 Runtimes saved to localStorage');
    } catch (error) {
      console.error('❌ Failed to save runtimes:', error);
    }
  },

  // Create new runtime from seed
  async createRuntime(name: string, seed: string): Promise<Runtime> {
    // Derive first signer (index 0)
    const firstAddress = deriveAddress(seed, 0);

    // Use signer EOA as ID (deterministic, unique)
    const id = firstAddress;
    const label = name;

    const runtime: Runtime = {
      id,
      label,
      seed,
      signers: [{
        index: 0,
        address: firstAddress,
        name: 'Signer 1'
      }],
      activeSignerIndex: 0,
      createdAt: Date.now()
    };

    runtimesState.update(state => ({
      ...state,
      runtimes: {
        ...state.runtimes,
        [id]: runtime
      },
      activeRuntimeId: id
    }));

    this.saveToStorage();

    // CRITICAL: Create NEW isolated runtime for this runtime (AWAIT to avoid race)
    const runtimeId = id; // Use runtime ID (EOA) as runtime ID
    console.log('[VaultStore.createRuntime] Creating isolated runtime:', runtimeId);

    // Import XLN and create env BEFORE returning
    const { getXLN } = await import('./xlnStore');
    const xln = await getXLN();
    const newEnv = xln.createEmptyEnv(seed);

    // REMOVED: setRuntimeSeed() - seed now stored in env.runtimeSeed and passed to pure functions
    console.log('[VaultStore.createRuntime] Runtime seed stored in env.runtimeSeed (pure)');
    // All crypto functions now read from env.runtimeSeed, not global state

    // Create ISOLATED BrowserVM for this runtime
    console.log('[VaultStore.createRuntime] Initializing isolated BrowserVM...');
    const { BrowserEVM } = await import('@xln/runtime/evms/browser-evm');
    const browserVM = new BrowserEVM();
    await browserVM.init();
    newEnv.browserVM = browserVM.getProvider(); // Store provider instance in env
    console.log('[VaultStore.createRuntime] ✅ BrowserVM initialized for runtime:', runtimeId);

    // Set BrowserVM jurisdiction (updates DEFAULT_JURISDICTIONS for this env)
    await xln.setBrowserVMJurisdiction(newEnv, browserVM.getDepositoryAddress(), browserVM.getProvider());

    // Add to runtimes store
    runtimes.update(r => {
      r.set(runtimeId, {
        id: runtimeId,
        type: 'local',
        label: label,
        env: newEnv,
        seed: runtime.seed,
        vaultId: id,
        permissions: 'write',
        status: 'connected'
      });
      return r;
    });

    // Switch to new runtime
    activeRuntimeId.set(runtimeId);
    console.log('[VaultStore.createRuntime] ✅ Runtime created and ready:', runtimeId);

    // Sync runtime seed
    this.syncRuntime(runtime);

    return runtime;
  },

  // Alias for backward compatibility
  async createVault(name: string, seed: string): Promise<Runtime> {
    return this.createRuntime(name, seed);
  },

  // Select runtime
  async selectRuntime(runtimeId: string) {
    runtimesState.update(state => ({
      ...state,
      activeRuntimeId: runtimeId
    }));
    this.saveToStorage();

    // CRITICAL: Switch to runtime's isolated runtime + seed
    const current = get(runtimesState);
    const runtime = current.runtimes[runtimeId];

    if (runtime) {
      // REMOVED: setRuntimeSeed() - seed stored in env.runtimeSeed (pure)
      console.log('[VaultStore.selectRuntime] Switched to runtime (seed in env):', runtimeId.slice(0, 10));
    }

    activeRuntimeId.set(runtimeId);
    this.syncRuntime(runtime || null);
  },

  // Alias for backward compatibility
  async selectVault(vaultId: string) {
    await this.selectRuntime(vaultId);
  },

  // Add signer to active runtime
  addSigner(name?: string): Signer | null {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return null;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime) return null;

    const nextIndex = runtime.signers.length;
    const address = deriveAddress(runtime.seed, nextIndex);

    const newSigner: Signer = {
      index: nextIndex,
      address,
      name: name || `Signer ${nextIndex + 1}`
    };

    runtimesState.update(state => ({
      ...state,
      runtimes: {
        ...state.runtimes,
        [runtime.id]: {
          ...runtime,
          signers: [...runtime.signers, newSigner]
        }
      }
    }));

    this.saveToStorage();

    // Auto-create ephemeral entity for this signer (async, non-blocking)
    import('../utils/entityFactory').then(({ autoCreateEntityForSigner }) => {
      autoCreateEntityForSigner(address).then(entityId => {
        if (entityId) {
          this.setSignerEntity(nextIndex, entityId);
          console.log(`[VaultStore] ✅ Entity created for signer ${address.slice(0, 10)}`);
        }
      }).catch(err => {
        console.warn('[VaultStore] Failed to auto-create entity:', err);
      });
    });
    void fundSignerWalletInBrowserVM(address);

    return newSigner;
  },

  // Select signer
  selectSigner(index: number) {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime || index >= runtime.signers.length) return;

    runtimesState.update(state => ({
      ...state,
      runtimes: {
        ...state.runtimes,
        [runtime.id]: {
          ...runtime,
          activeSignerIndex: index
        }
      }
    }));

    this.saveToStorage();
  },

  // Rename signer
  renameSigner(index: number, name: string) {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime || index >= runtime.signers.length) return;

    runtimesState.update(state => ({
      ...state,
      runtimes: {
        ...state.runtimes,
        [runtime.id]: {
          ...runtime,
          signers: runtime.signers.map((s, i) =>
            i === index ? { ...s, name } : s
          )
        }
      }
    }));

    this.saveToStorage();
  },

  // Set entity ID for signer
  setSignerEntity(signerIndex: number, entityId: string) {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime || signerIndex >= runtime.signers.length) return;

    runtimesState.update(state => ({
      ...state,
      runtimes: {
        ...state.runtimes,
        [runtime.id]: {
          ...runtime,
          signers: runtime.signers.map((s, i) =>
            i === signerIndex ? { ...s, entityId } : s
          )
        }
      }
    }));

    this.saveToStorage();
  },

  // Delete runtime
  deleteRuntime(runtimeId: string) {
    runtimesState.update(state => {
      const { [runtimeId]: removed, ...remaining } = state.runtimes;
      const remainingIds = Object.keys(remaining);

      return {
        runtimes: remaining,
        activeRuntimeId: state.activeRuntimeId === runtimeId
          ? (remainingIds[0] || null)
          : state.activeRuntimeId
      };
    });

    this.saveToStorage();
    const current = get(runtimesState);
    this.syncRuntime(current.activeRuntimeId ? current.runtimes[current.activeRuntimeId] || null : null);
  },

  // Alias for backward compatibility
  deleteVault(vaultId: string) {
    this.deleteRuntime(vaultId);
  },

  // Get private key for active signer
  getActiveSignerPrivateKey(): string | null {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return null;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime) return null;

    return derivePrivateKey(runtime.seed, runtime.activeSignerIndex);
  },

  // Get private key for specific signer
  getSignerPrivateKey(signerIndex: number): string | null {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return null;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime || signerIndex >= runtime.signers.length) return null;

    return derivePrivateKey(runtime.seed, signerIndex);
  },

  // Check if runtime exists
  runtimeExists(id: string): boolean {
    const current = get(runtimesState);
    if (!current?.runtimes) return false;
    return id in current.runtimes;
  },

  // Alias for backward compatibility
  vaultExists(id: string): boolean {
    return this.runtimeExists(id);
  },

  // Initialize
  async initialize() {
    this.loadFromStorage();
    const current = get(runtimesState);
    const runtime = current.activeRuntimeId ? current.runtimes[current.activeRuntimeId] || null : null;

    if (runtime) {
      // CRITICAL: Ensure runtime exists for this runtime
      const runtimeId = runtime.id;
      const existingRuntime = get(runtimes).get(runtimeId);

      if (!existingRuntime) {
        console.log('[VaultStore.initialize] Creating runtime for restored runtime:', runtimeId);

        const { getXLN } = await import('./xlnStore');
        const xln = await getXLN();
        const newEnv = xln.createEmptyEnv(runtime.seed);

        // REMOVED: setRuntimeSeed() - seed stored in env.runtimeSeed (pure)
        // All crypto functions now read from env.runtimeSeed, not global state

        // Create ISOLATED BrowserVM for restored runtime
        console.log('[VaultStore.initialize] Initializing isolated BrowserVM...');
        const { BrowserEVM } = await import('@xln/runtime/evms/browser-evm');
        const browserVM = new BrowserEVM();
        await browserVM.init();
        newEnv.browserVM = browserVM.getProvider(); // Store provider instance in env
        console.log('[VaultStore.initialize] ✅ BrowserVM initialized for runtime:', runtimeId);

        // Set BrowserVM jurisdiction
        await xln.setBrowserVMJurisdiction(newEnv, browserVM.getDepositoryAddress(), browserVM.getProvider());

        runtimes.update(r => {
          r.set(runtimeId, {
            id: runtimeId,
            type: 'local',
            label: runtime.label,
            env: newEnv,
            seed: runtime.seed,
            vaultId: runtime.id,
            permissions: 'write',
            status: 'connected'
          });
          return r;
        });

        activeRuntimeId.set(runtimeId);
        console.log('[VaultStore.initialize] ✅ Runtime created for runtime:', runtimeId);
      } else {
        // Runtime exists, just switch to it
        // REMOVED: setRuntimeSeed() - seed already in env.runtimeSeed (pure)
        console.log('[VaultStore.initialize] Switched to existing runtime (seed in env):', runtimeId.slice(0, 10));

        activeRuntimeId.set(runtimeId);
      }
    }

    this.syncRuntime(runtime);
  },

  // Clear all runtimes
  clearAll() {
    runtimesState.set(defaultState);
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(VAULT_STORAGE_KEY);
    }
    this.syncRuntime(null);
  }
};
