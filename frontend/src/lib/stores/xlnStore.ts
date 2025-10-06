import { writable, derived, get } from 'svelte/store';
import { errorLog } from './errorLogStore';

// Direct import of XLN server module (no wrapper boilerplate needed)
let XLN: any = null;

async function getXLN() {
  if (XLN) return XLN;

  const serverUrl = new URL('/server.js', window.location.origin).href;
  XLN = await import(/* @vite-ignore */ serverUrl);

  // Expose globally for console debugging
  exposeGlobalDebugObjects();

  return XLN;
}

/**
 * Expose XLN objects globally for console debugging
 */
function exposeGlobalDebugObjects() {
  if (typeof window !== 'undefined' && XLN) {
    // @ts-ignore - Expose XLN server instance
    window.XLN = XLN;

    // @ts-ignore - Expose environment directly (avoid naming conflicts)
    window.xlnEnv = xlnEnvironment;

    // @ts-ignore - Expose error logger for server-side logging
    window.xlnErrorLog = (message: string, source: string, details?: any) => {
      errorLog.log(message, source, details);
    };

    console.log('🌍 GLOBAL DEBUG: XLN objects exposed');
    console.log('  window.XLN - All server functions (deriveDelta, isLeft, etc.)');
    console.log('  window.xlnEnv - Reactive environment store');
    console.log('  window.xlnErrorLog - Logs to Settings error panel');
    console.log('  Usage: window.XLN.deriveDelta(delta, true).ascii');
    console.log('  Usage: Get current env value with xlnEnv subscribe pattern');
  }
}

// Simple reactive store for XLN environment - just like legacy index.html
export const xlnEnvironment = writable<any>(null);
export const isLoading = writable<boolean>(true);
export const error = writable<string | null>(null);

// Store XLN instance separately for function access
export const xlnInstance = writable<any>(null);

// xlnFunctions is now defined at the end of the file

// Derived stores for convenience
export const replicas = derived(
  xlnEnvironment,
  ($env) => $env?.replicas || new Map()
);

export const history = derived(
  xlnEnvironment,
  ($env) => {
    const historyData = $env?.history || [];
    // LOAD-ORDER-DEBUG removed
    return historyData;
  }
);

export const currentHeight = derived(
  xlnEnvironment,
  ($env) => $env?.height || 0
);

// Track if XLN is already initialized to prevent data loss
let isInitialized = false;

// Helper functions for common patterns (not wrappers)
export async function initializeXLN() {
  // CRITICAL: Don't re-initialize if we already have data
  if (isInitialized) {
    const currentEnv = get(xlnEnvironment);
    if (currentEnv && currentEnv.replicas?.size > 0) {
      console.log('🛑 PREVENTED RE-INITIALIZATION: XLN already has data, keeping existing state');
      return currentEnv;
    }
  }

  try {
    isLoading.set(true);
    error.set(null);
    
    const xln = await getXLN();

    // Store XLN instance separately for function access
    xlnInstance.set(xln);
    console.log('✅ XLN instance stored with functions:', Object.keys(xln).filter(k => typeof xln[k] === 'function'));
    console.log('🔍 Looking for deriveDelta:', {
      hasDeriveDelta: 'deriveDelta' in xln,
      deriveDeltaType: typeof xln.deriveDelta,
      allAccountFunctions: Object.keys(xln).filter(k => k.includes('account') || k.includes('Delta') || k.includes('token'))
    });

    // Register callback for automatic reactivity
    xln.registerEnvChangeCallback?.((env: any) => {
      xlnEnvironment.set(env);
      // BROWSER-DEBUG removed

      // Update window for e2e testing
      if (typeof window !== 'undefined') {
        (window as any).xlnEnv = env;
      }
    });
    
    // Load from IndexedDB - main() handles timeout internally
    // BROWSER-DEBUG removed

    const env = await xln.main();
    // BROWSER-DEBUG removed

    // Replica debugging removed

    // History is now guaranteed to be included in env

    // LOAD-ORDER-DEBUG removed

    xlnEnvironment.set(env);
    isLoading.set(false);

    // Expose to window for e2e testing
    if (typeof window !== 'undefined') {
      (window as any).xlnEnv = env;
    }

    console.log('✅ XLN Environment initialized with auto-reactivity');
    isInitialized = true;
    return env;
  } catch (err) {
    console.error('🚨 CRITICAL: XLN initialization failed - this indicates a system failure:', err);

    // Log to persistent error store
    const errorMessage = err instanceof Error ? err.message : 'Critical system failure during initialization';
    errorLog.log(errorMessage, 'XLN Initialization', err);

    error.set(errorMessage);
    isLoading.set(false);

    // Don't mark as initialized on failure
    throw err;
  }
}

// Export XLN for direct use in components (like legacy index.html)
export { getXLN };

// Helper to get current environment
export function getEnv() {
  return get(xlnEnvironment);
}

// === FRONTEND UTILITY FUNCTIONS ===
// Derived store that provides utility functions for components
export const xlnFunctions = derived([xlnEnvironment, xlnInstance], ([, $xlnInstance]) => {
  // XLN is full in-memory snapshots - NO LOADING STATE NEEDED

  // If xlnInstance is missing, return empty functions that throw clear errors
  if (!$xlnInstance) {
    console.error('❌ CRITICAL: xlnInstance is null - XLN not initialized');
    return {
      getEntityNumber: () => { throw new Error('XLN not initialized'); },
      isReady: false
    };
  }

  return {
    // Account utilities
    deriveDelta: $xlnInstance.deriveDelta,
    formatTokenAmount: $xlnInstance.formatTokenAmount,
    getTokenInfo: $xlnInstance.getTokenInfo,
    isLeft: $xlnInstance.isLeft,
    createDemoDelta: $xlnInstance.createDemoDelta,
    getDefaultCreditLimit: $xlnInstance.getDefaultCreditLimit,
    safeStringify: $xlnInstance.safeStringify,

    // Financial utilities (ethers.js-based, precision-safe)
    formatTokenAmountEthers: $xlnInstance.formatTokenAmountEthers,
    parseTokenAmount: $xlnInstance.parseTokenAmount,
    convertTokenPrecision: $xlnInstance.convertTokenPrecision,
    calculatePercentageEthers: $xlnInstance.calculatePercentageEthers,
    formatAssetAmountEthers: $xlnInstance.formatAssetAmountEthers,
    BigIntMath: $xlnInstance.BigIntMath,
    FINANCIAL_CONSTANTS: $xlnInstance.FINANCIAL_CONSTANTS,

    // Entity utilities - UNIFIED ENTITY ACCESS
    getEntity: (entityId: string) => {
      try {
        const number = $xlnInstance.getEntityNumber(entityId);
        if (typeof number !== 'number' || isNaN(number)) {
          throw new Error(`FINTECH-SAFETY: getEntityNumber returned invalid: ${number}`);
        }
        return {
          id: entityId,
          number,
          display: `Entity #${number}`,
          avatar: $xlnInstance.generateEntityAvatar?.(entityId) || '',
          info: $xlnInstance.getEntityDisplayInfo?.(entityId) || { name: entityId, avatar: '', type: 'numbered' }
        };
      } catch (error) {
        console.error('FINTECH-SAFETY: Entity access failed:', error);
        throw error; // Fail fast - don't hide errors
      }
    },

    // Legacy functions (use getEntity() instead)
    getEntityNumber: (entityId: string): number => {
      try {
        const result = $xlnInstance.getEntityNumber(entityId);
        if (typeof result !== 'number' || isNaN(result)) {
          throw new Error(`FINTECH-SAFETY: getEntityNumber returned invalid: ${result}`);
        }
        return result;
      } catch (error) {
        console.error('FINTECH-SAFETY: Entity number extraction failed:', error);
        throw error; // Fail fast - don't hide errors
      }
    },
    formatEntityDisplay: $xlnInstance.formatEntityDisplay,
    formatShortEntityId: $xlnInstance.formatShortEntityId,

    // Avatar generation (using XLN instance functions)
    generateEntityAvatar: (entityId: string): string => {
      try {
        return $xlnInstance.generateEntityAvatar?.(entityId) || '';
      } catch (error) {
        console.error('Error generating entity avatar:', error);
        return '';
      }
    },

    generateSignerAvatar: (signerId: string): string => {
      try {
        const result = $xlnInstance.generateSignerAvatar?.(signerId) || '';
        return result;
      } catch (error) {
        console.error('Error generating signer avatar:', error);
        return '';
      }
    },

    // Entity display helpers
    getEntityDisplayInfo: (entityId: string) => {
      try {
        return $xlnInstance.getEntityDisplayInfo?.(entityId) || { name: entityId, avatar: '', type: 'lazy' };
      } catch {
        return { name: entityId, avatar: '', type: 'lazy' };
      }
    },

    // Signer display helpers
    getSignerDisplayInfo: (signerId: string) => {
      try {
        return $xlnInstance.getSignerDisplayInfo?.(signerId) || { name: signerId, address: signerId, avatar: '' };
      } catch {
        return { name: signerId, address: signerId, avatar: '' };
      }
    },

    // State management - indicates functions are fully loaded
    isReady: true
  };
});