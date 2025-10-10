import { writable, derived, get } from 'svelte/store';
import { errorLog } from './errorLogStore';
import { settings } from './settingsStore';

// Direct import of XLN server module (no wrapper boilerplate needed)
let XLN: any = null;

async function getXLN() {
  if (XLN) return XLN;

  // Add timestamp to bust cache
  const serverUrl = new URL(`/server.js?v=${Date.now()}`, window.location.origin).href;
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

// Direct stores for immediate updates (no derived timing races)
export const history = writable<any[]>([]);
export const currentHeight = writable<number>(0);

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

  // FAILSAFE: Auto-disable loading after 10s to prevent stuck UI
  const loadingTimeout = setTimeout(() => {
    console.error('⚠️ Loading timeout (10s) - forcing isLoading=false to prevent stuck UI');
    isLoading.set(false);
    error.set('Loading timed out. UI may be incomplete. Check Settings for details.');
  }, 10000);

  try {
    isLoading.set(true);
    error.set(null);

    const xln = await getXLN();

    // Store XLN instance separately for function access
    xlnInstance.set(xln);

    // Register callback for automatic reactivity (fires on every processUntilEmpty)
    xln.registerEnvChangeCallback?.((env: any) => {
      xlnEnvironment.set(env);
      history.set(env?.history || []);
      currentHeight.set(env?.height || 0);

      // Update window for e2e testing
      if (typeof window !== 'undefined') {
        (window as any).xlnEnv = env;
      }
    });

    // Load from IndexedDB - main() handles DB timeout internally
    const env = await xln.main();

    // Set all stores immediately (no derived timing races)
    xlnEnvironment.set(env);
    history.set(env?.history || []);
    currentHeight.set(env?.height || 0);
    isLoading.set(false);

    // Expose to window for e2e testing
    if (typeof window !== 'undefined') {
      (window as any).xlnEnv = env;
    }

    console.log('✅ XLN Environment initialized');
    isInitialized = true;

    clearTimeout(loadingTimeout);
    return env;
  } catch (err) {
    clearTimeout(loadingTimeout);
    console.error('🚨 XLN initialization failed:', err);

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

// Wrapper for processUntilEmpty that auto-injects serverDelay from settings
export async function processWithDelay(env: any, inputs?: any[]) {
  const xln = await getXLN();
  const delay = get(settings).serverDelay;
  return await xln.processUntilEmpty(env, inputs, delay);
}

// === FRONTEND UTILITY FUNCTIONS ===
// Derived store that provides utility functions for components
export const xlnFunctions = derived([xlnEnvironment, xlnInstance], ([, $xlnInstance]) => {
  // XLN is full in-memory snapshots - NO LOADING STATE NEEDED

  // If xlnInstance is missing, return empty functions that throw clear errors
  if (!$xlnInstance) {
    console.error('❌ CRITICAL: xlnInstance is null - XLN not initialized');
    const notReady = () => { throw new Error('XLN not initialized'); };
    return {
      // Account utilities
      deriveDelta: notReady as any,
      formatTokenAmount: notReady as any,
      getTokenInfo: notReady as any,
      isLeft: notReady as any,
      createDemoDelta: notReady as any,
      getDefaultCreditLimit: notReady as any,
      safeStringify: notReady as any,

      // Financial utilities
      formatTokenAmountEthers: notReady as any,
      parseTokenAmount: notReady as any,
      convertTokenPrecision: notReady as any,
      calculatePercentageEthers: notReady as any,
      formatAssetAmountEthers: notReady as any,
      BigIntMath: notReady as any,
      FINANCIAL_CONSTANTS: {} as any,

      // Entity utilities
      getEntity: notReady as any,
      getEntityShortId: notReady as any,
      formatEntityId: notReady as any,
      getEntityNumber: notReady as any,
      formatEntityDisplay: notReady as any,
      formatShortEntityId: notReady as any,

      // Avatar generation
      generateEntityAvatar: notReady as any,
      generateSignerAvatar: notReady as any,
      getEntityDisplayInfo: notReady as any,

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
        const shortId = $xlnInstance.getEntityShortId(entityId);
        if (!shortId) {
          throw new Error(`FINTECH-SAFETY: getEntityShortId returned empty: ${shortId}`);
        }
        const display = $xlnInstance.formatEntityId(entityId);
        return {
          id: entityId,
          shortId,
          display,
          avatar: $xlnInstance.generateEntityAvatar?.(entityId) || '',
          info: $xlnInstance.getEntityDisplayInfo?.(entityId) || { name: entityId, avatar: '', type: 'numbered' }
        };
      } catch (error) {
        console.error('FINTECH-SAFETY: Entity access failed:', error);
        throw error; // Fail fast - don't hide errors
      }
    },

    // Entity helper functions
    getEntityShortId: (entityId: string): string => {
      try {
        const result = $xlnInstance.getEntityShortId(entityId);
        if (!result) {
          throw new Error(`FINTECH-SAFETY: getEntityShortId returned empty: ${result}`);
        }
        return result;
      } catch (error) {
        console.error('FINTECH-SAFETY: Entity ID extraction failed:', error);
        throw error; // Fail fast - don't hide errors
      }
    },

    formatEntityId: $xlnInstance.formatEntityId,

    // Legacy function (use getEntityShortId instead)
    getEntityNumber: (entityId: string): string => {
      return $xlnInstance.getEntityShortId(entityId);
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