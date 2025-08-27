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

// Lean operations - just like legacy index.html approach
export const xlnOperations = {
  // Initialize XLN environment - direct call to XLN.main()
  async initialize() {
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
  },

  // Direct access to XLN functions (no wrapper boilerplate)
  async getXLN() {
    return await getXLN();
  },

  // Run demo - matches legacy index.html functionality
  async runDemo() {
    try {
      const xln = await getXLN();
      const env = xlnEnvironment.get() || await this.initialize();
      
      console.log('🎯 Running XLN demo...');
      const result = await xln.runDemo(env);
      
      // Update environment with demo results
      xlnEnvironment.set(result);
      console.log('✅ Demo completed successfully');
      return result;
    } catch (err) {
      console.error('❌ Demo failed:', err);
      error.set(`Demo failed: ${err.message}`);
      throw err;
    }
  }
};

// Export XLN for direct use in components (like legacy index.html)
export { getXLN };