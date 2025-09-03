import { writable, derived } from 'svelte/store';

// Direct import of XLN server module (no wrapper boilerplate needed)
let XLN: any = null;

async function getXLN() {
  if (XLN) return XLN;
  
  const serverUrl = new URL('/server.js', window.location.origin).href;
  XLN = await import(/* @vite-ignore */ serverUrl);
  return XLN;
}

// Simple reactive store for XLN environment - just like legacy index.html
export const xlnEnvironment = writable<any>(null);
export const isLoading = writable<boolean>(true);
export const error = writable<string | null>(null);

// Derived stores for convenience
export const replicas = derived(
  xlnEnvironment,
  ($env) => $env?.replicas || new Map()
);

export const history = derived(
  xlnEnvironment,
  ($env) => $env?.history || []
);

export const currentHeight = derived(
  xlnEnvironment,
  ($env) => $env?.height || 0
);

// Helper functions for common patterns (not wrappers)
export async function initializeXLN() {
  try {
    isLoading.set(true);
    error.set(null);
    
    const xln = await getXLN();
    
    // Register callback for automatic reactivity
    xln.registerEnvChangeCallback?.((env: any) => {
      xlnEnvironment.set(env);
      console.log('🔄 Environment updated automatically');
      
      // Update window for e2e testing
      if (typeof window !== 'undefined') {
        (window as any).xlnEnv = env;
      }
    });
    
    // Local DB should load instantly - if not, just proceed with empty state
    console.log('🚀 Starting XLN initialization...');
    const env = await Promise.race([
      xln.main(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Local DB taking too long - using empty state')), 200)
      )
    ]);

    // History is now guaranteed to be included in env
    
    xlnEnvironment.set(env);
    isLoading.set(false);
    
    // Expose to window for e2e testing
    if (typeof window !== 'undefined') {
      (window as any).xlnEnv = env;
    }
    
    console.log('✅ XLN Environment initialized with auto-reactivity');
    return env;
  } catch (err) {
    console.error('❌ XLN initialization failed:', err);
    
    // If initialization fails, try to create a minimal environment
    try {
      const xln = await getXLN();
      console.log('🔄 Attempting minimal environment creation...');
      
      const minimalEnv = {
        replicas: new Map(),
        height: 0,
        timestamp: Date.now(),
        serverInput: { serverTxs: [], entityInputs: [] },
        history: []
      };
      
      xlnEnvironment.set(minimalEnv);
      isLoading.set(false);
      
      if (typeof window !== 'undefined') {
        (window as any).xlnEnv = minimalEnv;
      }
      
      console.log('✅ Minimal XLN Environment created');
      return minimalEnv;
    } catch (fallbackErr) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to initialize';
      error.set(errorMessage);
      isLoading.set(false);
      console.error('❌ Fallback initialization also failed:', fallbackErr);
      throw err;
    }
  }
}

// Export XLN for direct use in components (like legacy index.html)
export { getXLN };