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

let initializePromise: Promise<void> | null = null;
let initialized = false;

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

type JurisdictionConfig = {
  name: string;
  chainId: number;
  rpc: string;
  contracts: {
    depository: string;
    entityProvider: string;
    account?: string;
    deltaTransformer?: string;
  };
};

const resolveJurisdictionConfig = (jurisdictions: any): JurisdictionConfig => {
  const map = jurisdictions?.jurisdictions ?? {};
  const arrakis = map.arrakis;
  const first = arrakis ?? Object.values(map)[0];
  if (!first) {
    throw new Error('No jurisdictions found in jurisdictions.json');
  }
  return first as JurisdictionConfig;
};

const resolveRpcUrl = (rpc: string, baseOrigin?: string): string => {
  if (!rpc) throw new Error('Missing RPC URL in jurisdictions.json');
  if (typeof window !== 'undefined' && rpc.startsWith('http')) {
    try {
      const parsed = new URL(rpc);
      const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '0.0.0.0';
      if (isLocal) {
        const origin = baseOrigin ?? window.location.origin;
        return new URL('/rpc', origin).toString();
      }
    } catch {
      // fall through
    }
  }
  if (rpc.startsWith('http')) return rpc;
  if (typeof window !== 'undefined') {
    const origin = baseOrigin ?? window.location.origin;
    return new URL(rpc, origin).toString();
  }
  return rpc;
};

const fetchJurisdictions = async (baseOrigin?: string): Promise<any> => {
  const primaryOrigin = baseOrigin ?? (typeof window !== 'undefined' ? window.location.origin : 'https://xln.finance');
  const candidates = [
    `${primaryOrigin}/jurisdictions.json`,
    ...(primaryOrigin !== 'https://xln.finance' ? ['https://xln.finance/jurisdictions.json'] : []),
  ];

  let lastError: unknown = null;
  for (const url of candidates) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        lastError = new Error(`HTTP ${resp.status}`);
        continue;
      }
      return await resp.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('Failed to fetch jurisdictions.json');
};

async function fundSignerWalletViaFaucet(address: string): Promise<void> {
  try {
    // Call testnet faucet API (Faucet A - ERC20 to wallet)
    const apiBase = typeof window !== 'undefined' ? window.location.origin : 'https://xln.finance';
    const response = await fetch(`${apiBase}/api/faucet/erc20`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userAddress: address,
        tokenSymbol: 'USDC',
        amount: '100'
      })
    });

    const raw = await response.text();
    let result: any = null;
    if (raw) {
      try { result = JSON.parse(raw); } catch { /* ignore */ }
    }

    if (!response.ok) {
      const errorMsg = result?.error || `Faucet failed (${response.status})`;
      console.warn('[VaultStore] Faucet failed:', errorMsg);
      return;
    }

    if (result?.success) {
      console.log('[VaultStore] ✅ Funded wallet via faucet:', result.txHash);
    } else {
      console.warn('[VaultStore] Faucet failed:', result?.error || 'Unknown faucet error');
    }
  } catch (err) {
    console.warn('[VaultStore] Failed to call faucet:', err);
  }
}

async function fundRuntimeSignersInBrowserVM(runtime: Runtime | null): Promise<void> {
  if (!runtime) return;
  for (const signer of runtime.signers) {
    await fundSignerWalletViaFaucet(signer.address);
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

    // Sync runtime seed and start P2P with correct relay URLs
    if (runtime?.seed && runtime?.id) {
      import('$lib/stores/xlnStore').then(async ({ getXLN, resolveRelayUrls }) => {
        const { get } = await import('svelte/store');
        const xln = await getXLN();
        if (xln.setRuntimeSeed) {
          xln.setRuntimeSeed(runtime.seed);
        }
        // Start P2P on the VaultStore's runtime env (not xlnStore's global env)
        if (xln.startP2P && xln.deriveRuntimeId) {
          // Get the env from this specific runtime in runtimeStore
          const runtimeData = get(runtimes).get(runtime.id);
          const env = runtimeData?.env;
          if (env) {
            // CRITICAL: Set runtimeId on THIS env (not the global one)
            // This allows P2P to start immediately instead of being deferred
            if (!env.runtimeId && runtime.seed) {
              env.runtimeId = xln.deriveRuntimeId(runtime.seed);
              env.runtimeSeed = runtime.seed;
              console.log(`[VaultStore] P2P: Set env.runtimeId = ${env.runtimeId.slice(0, 12)}...`);
            }
            const relayUrls = resolveRelayUrls();
            console.log(`[VaultStore] P2P: Starting on env with ${env.eReplicas?.size || 0} entities, runtimeId=${env.runtimeId?.slice(0,12)}, relay=${relayUrls[0]}`);
            xln.startP2P(env, { relayUrls, gossipPollMs: 0 });
          } else {
            console.warn('[VaultStore] P2P: No env found for runtime', runtime.id);
          }
        }
        console.log('[VaultStore] P2P: Runtime seed synced, P2P connected');
      }).catch(err => console.warn('[VaultStore] Failed to sync P2P seed:', err));
    }

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
      console.error('❌ Failed to load runtimes (clearing corrupted storage):', error);
      localStorage.removeItem(VAULT_STORAGE_KEY);
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

    // Fetch pre-deployed contract addresses from prod
    console.log('[VaultStore.createRuntime] Fetching jurisdictions.json...');
    const baseOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://xln.finance';
    const jurisdictions = await fetchJurisdictions(baseOrigin);
    const arrakisConfig = resolveJurisdictionConfig(jurisdictions);
    console.log('[VaultStore.createRuntime] Loaded contracts:', arrakisConfig.contracts);
    const rpcUrl = resolveRpcUrl(arrakisConfig.rpc, baseOrigin);

    // Import testnet J-machine (shared anvil on xln.finance)
    console.log('[VaultStore.createRuntime] Importing testnet anvil...');
    await xln.applyRuntimeInput(newEnv, {
      runtimeTxs: [{
        type: 'importJ',
        data: {
          name: 'Testnet',
          chainId: arrakisConfig.chainId,
          ticker: 'USDC',
          rpcs: [rpcUrl],
          contracts: arrakisConfig.contracts, // Use pre-deployed addresses
        }
      }],
      entityInputs: []
    });
    if (xln.startJEventWatcher) {
      await xln.startJEventWatcher(newEnv);
    }
    console.log('[VaultStore.createRuntime] ✅ Testnet imported');

    // === MVP: Create entity ===
    console.log('[VaultStore.createRuntime] Creating user entity...');
    const { generateLazyEntityId } = await import('@xln/runtime/entity-factory');
    const { applyRuntimeInput } = await import('@xln/runtime/runtime');

    // Create entity config (single-signer, threshold 1)
    const signerAddress = firstAddress;

    // Get contract addresses from imported J-machine
    const jReplica = newEnv.jReplicas?.get('Testnet');
    if (!jReplica) {
      throw new Error('Testnet J-machine not found after import');
    }
    const depositoryAddress = jReplica.depositoryAddress;
    const entityProviderAddress = jReplica.entityProviderAddress;

    // Generate entityId using canonical lazy entity ID (sorted validators, consistent encoding)
    // This ensures same signer → same entityId regardless of where it's generated
    // For lazy entities: entityId == boardHash (as per EntityProvider contract)
    //
    // TODO(provider-scoped-entities): Current format is entityId = boardHash (local to EP)
    // Future format: entityAddress = hash(providerAddress + entityId)
    // Why: Same boardHash on different EntityProviders should be different global addresses
    //      (like user@google vs user@github in OAuth)
    // When: Needed for multi-jurisdiction routing and cross-EP entity references
    // Impact on Hanko:
    //   - Current: 65-byte short hanko (signature only) - sufficient for self-entities
    //   - Future: Extended hanko = sig(65) + entityId(32) + providerAddress(20) = 117 bytes
    //   - Verifier reconstructs entityAddress from hanko fields
    // EP Generalization:
    //   - Current: Single EP per Depository (rigid but simple)
    //   - Future: Multiple EPs can authenticate/dispute in same Depository
    //   - Cross-EP entity references for federated trust
    const entityId = generateLazyEntityId([signerAddress], 1n);
    console.log('[VaultStore.createRuntime] Entity ID:', entityId.slice(0, 18) + '...');
    console.log('[VaultStore.createRuntime]   signer:', signerAddress);
    console.log('[VaultStore.createRuntime]   provider:', entityProviderAddress);

    const entityConfig = {
      mode: 'proposer-based' as const,
      threshold: 1n,
      validators: [signerAddress],
      shares: { [signerAddress]: 1n },
      jurisdiction: {
        address: depositoryAddress,
        name: 'Testnet',
        chainId: 31337,
        entityProviderAddress: entityProviderAddress,
        depositoryAddress: depositoryAddress,
      }
    };

    // CRITICAL: Register HD-derived private key with runtime BEFORE importing entity
    // Why: Runtime's deriveSignerKeySync uses different derivation than BIP44 HD
    // The vault uses BIP44 (m/44'/60'/0'/0/index), runtime uses keccak256(seed+signerId)
    // Without this, hanko verification fails (signature from wrong key)
    const signerPrivateKey = derivePrivateKey(seed, 0);
    const privateKeyBytes = new Uint8Array(
      signerPrivateKey.slice(2).match(/.{2}/g)!.map(byte => parseInt(byte, 16))
    );
    xln.registerSignerKey(signerAddress, privateKeyBytes);
    console.log('[VaultStore.createRuntime] ✅ Registered HD-derived private key for signer');

    // Import entity replica into runtime
    await applyRuntimeInput(newEnv, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId: entityId,
        signerId: signerAddress,
        data: {
          isProposer: true,
          config: entityConfig
        }
      }],
      entityInputs: []
    });

    // Skip auto-funding (use faucet API)
    console.log('[VaultStore.createRuntime] ✅ Entity ready (use /api/faucet to fund)');

    // Store entityId in signer
    runtime.signers[0]!.entityId = entityId;
    runtimesState.update(state => ({
      ...state,
      runtimes: { ...state.runtimes, [id]: runtime }
    }));
    this.saveToStorage();

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
    console.log('[VaultStore.createRuntime] ✅ Runtime created with entity:', entityId.slice(0, 18));

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
      // CRITICAL: Re-register ALL signer private keys when switching runtimes
      // Keys are stored in memory (signerKeys Map), lost on page refresh
      // Must re-register from HD derivation to enable signing
      const { getXLN } = await import('./xlnStore');
      const xln = await getXLN();

      for (const signer of runtime.signers) {
        const privateKey = derivePrivateKey(runtime.seed, signer.index);
        const privateKeyBytes = new Uint8Array(
          privateKey.slice(2).match(/.{2}/g)!.map(byte => parseInt(byte, 16))
        );
        xln.registerSignerKey(signer.address, privateKeyBytes);
      }
      console.log(`[VaultStore.selectRuntime] ✅ Registered ${runtime.signers.length} signer keys`);
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

    // CRITICAL: Register HD-derived private key with runtime BEFORE creating entity
    // Why: Runtime's deriveSignerKeySync uses different derivation than BIP44 HD
    // Without this, hanko verification fails (signature from wrong key)
    import('./xlnStore').then(async ({ getXLN }) => {
      const xln = await getXLN();
      const privateKey = derivePrivateKey(runtime.seed, nextIndex);
      const privateKeyBytes = new Uint8Array(
        privateKey.slice(2).match(/.{2}/g)!.map(byte => parseInt(byte, 16))
      );
      xln.registerSignerKey(address, privateKeyBytes);
      console.log(`[VaultStore] ✅ Registered HD key for signer ${address.slice(0, 10)}`);

      // Now create entity (key is registered, signing will work)
      const { autoCreateEntityForSigner } = await import('../utils/entityFactory');
      const entityId = await autoCreateEntityForSigner(address);
      if (entityId) {
        this.setSignerEntity(nextIndex, entityId);
        console.log(`[VaultStore] ✅ Entity created for signer ${address.slice(0, 10)}`);
      }
    }).catch(err => {
      console.warn('[VaultStore] Failed to register key/create entity:', err);
    });

    void fundSignerWalletViaFaucet(address);

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
    if (initialized) return;
    if (initializePromise) return initializePromise;

    initializePromise = (async () => {
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

        // CRITICAL: Register ALL signer private keys from HD derivation BEFORE any entity ops
        // Why: Runtime's deriveSignerKeySync uses different derivation than BIP44 HD
        // Without this, hanko verification fails (signature from wrong key)
        for (const signer of runtime.signers) {
          const privateKey = derivePrivateKey(runtime.seed, signer.index);
          const privateKeyBytes = new Uint8Array(
            privateKey.slice(2).match(/.{2}/g)!.map(byte => parseInt(byte, 16))
          );
          xln.registerSignerKey(signer.address, privateKeyBytes);
        }
        console.log(`[VaultStore.initialize] ✅ Registered ${runtime.signers.length} HD-derived keys`);

        // CRITICAL: Import testnet J-machine (shared anvil on xln.finance)
        // This must happen on page reload when restoring runtime from localStorage
        console.log('[VaultStore.initialize] Fetching jurisdictions.json...');
        const baseOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://xln.finance';
        const jurisdictions = await fetchJurisdictions(baseOrigin);
        const arrakisConfig = resolveJurisdictionConfig(jurisdictions);
        const rpcUrl = resolveRpcUrl(arrakisConfig.rpc, baseOrigin);

        console.log('[VaultStore.initialize] Importing testnet anvil...');
        await xln.applyRuntimeInput(newEnv, {
          runtimeTxs: [{
            type: 'importJ',
            data: {
              name: 'Testnet',
              chainId: arrakisConfig.chainId,
              ticker: 'USDC',
              rpcs: [rpcUrl],
              contracts: arrakisConfig.contracts, // Use pre-deployed addresses
            }
          }],
          entityInputs: []
        });
        if (xln.startJEventWatcher) {
          await xln.startJEventWatcher(newEnv);
        }
        console.log('[VaultStore.initialize] ✅ Testnet imported');

        // Re-import entity if it exists in runtime
        if (runtime.signers[0]?.entityId) {
          const entityId = runtime.signers[0].entityId;
          const signerAddress = runtime.signers[0].address;

          const jReplica = newEnv.jReplicas?.get('Testnet');
          if (jReplica) {
            const { generateLazyEntityId } = await import('@xln/runtime/entity-factory');
            const { applyRuntimeInput } = await import('@xln/runtime/runtime');

            const entityConfig = {
              mode: 'proposer-based' as const,
              threshold: 1n,
              validators: [signerAddress],
              shares: { [signerAddress]: 1n },
              jurisdiction: {
                address: jReplica.depositoryAddress,
                name: 'Testnet',
                chainId: 31337,
                entityProviderAddress: jReplica.entityProviderAddress,
                depositoryAddress: jReplica.depositoryAddress,
              }
            };

            await applyRuntimeInput(newEnv, {
              runtimeTxs: [{
                type: 'importReplica',
                entityId: entityId,
                signerId: signerAddress,
                data: {
                  isProposer: true,
                  config: entityConfig
                }
              }],
              entityInputs: []
            });
            console.log('[VaultStore.initialize] ✅ Entity re-imported:', entityId.slice(0, 18));
          }
        }

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
      initialized = true;
    })();

    try {
      await initializePromise;
    } finally {
      initializePromise = null;
    }
  },

  // Clear all runtimes
  clearAll() {
    runtimesState.set(defaultState);
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(VAULT_STORAGE_KEY);
    }
    this.syncRuntime(null);
  },

  // === MVP: Get XLN balance for active entity ===
  async getEntityBalance(tokenId: number = 1): Promise<bigint> {
    const signer = get(activeSigner);
    if (!signer?.entityId) return 0n;

    try {
      const { getXLN } = await import('./xlnStore');
      const xln = await getXLN();
      const env = xln.getEnv();
      const jadapter = xln.getActiveJAdapter?.(env);
      if (!jadapter?.getReserves) return 0n;

      return await jadapter.getReserves(signer.entityId, tokenId);
    } catch (err) {
      console.error('[VaultStore] Failed to get balance:', err);
      return 0n;
    }
  },

  // === MVP: Send tokens to another entity ===
  async sendTokens(toEntityId: string, amount: bigint, tokenId: number = 1): Promise<{ success: boolean; error?: string }> {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return { success: false, error: 'No active runtime' };

    const runtime = current.runtimes[current.activeRuntimeId];
    const signer = runtime?.signers[runtime.activeSignerIndex];
    if (!signer?.entityId) return { success: false, error: 'No entity for signer' };

    try {
      const { getXLN } = await import('./xlnStore');
      const xln = await getXLN();
      const env = xln.getEnv();
      const jadapter = xln.getActiveJAdapter?.(env);
      if (!jadapter?.reserveToReserve) return { success: false, error: 'J-adapter not available' };

      // Execute reserve_to_reserve transfer
      await jadapter.reserveToReserve(signer.entityId, toEntityId, tokenId, amount);

      // Process queued J-events to update runtime state
      if (xln.processJBlockEvents) {
        await xln.processJBlockEvents();
      }

      console.log(`[VaultStore] ✅ Sent ${amount} to ${toEntityId.slice(0, 12)}...`);
      return { success: true };
    } catch (err) {
      console.error('[VaultStore] Send failed:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Transfer failed' };
    }
  },

  // Get active entity ID
  getActiveEntityId(): string | null {
    const signer = get(activeSigner);
    return signer?.entityId || null;
  }
};
