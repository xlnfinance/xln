import { writable, derived } from 'svelte/store';

// Direct import of XLN server module (no wrapper boilerplate needed)
let XLN: any = null;

async function getXLN() {
  if (XLN) return XLN;
  
  const serverUrl = new URL('/xln/server.js', window.location.origin).href;
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
    const env = await xln.main();

    // Ensure history exists for time machine
    env.history = env.history || xln.getHistory?.() || [];
    
    xlnEnvironment.set(env);
    isLoading.set(false);
    
    console.log('✅ XLN Environment initialized');
    return env;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Failed to initialize';
    error.set(errorMessage);
    isLoading.set(false);
    console.error('❌ XLN initialization failed:', err);
    throw err;
  }
}

// Export XLN for direct use in components (like legacy index.html)
export { getXLN };