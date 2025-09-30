// Central debug logging utility
// Enables/disables debug output based on environment

const isDev = import.meta.env.DEV;
const isDebugEnabled = isDev || localStorage.getItem('xln-debug') === 'true';

export const debug = {
  log: (...args: any[]) => {
    if (isDebugEnabled) console.log(...args);
  },

  warn: (...args: any[]) => {
    if (isDebugEnabled) console.warn(...args);
  },

  error: (...args: any[]) => {
    // Always show errors
    console.error(...args);
  },

  // Specialized loggers for different subsystems
  store: (...args: any[]) => {
    if (isDebugEnabled) console.log('🔄 STORE:', ...args);
  },

  time: (...args: any[]) => {
    if (isDebugEnabled) console.log('🕰️ TIME:', ...args);
  },

  entity: (...args: any[]) => {
    if (isDebugEnabled) console.log('🏢 ENTITY:', ...args);
  },

  account: (...args: any[]) => {
    if (isDebugEnabled) console.log('💳 ACCOUNT:', ...args);
  },

  network: (...args: any[]) => {
    if (isDebugEnabled) console.log('🌐 NETWORK:', ...args);
  }
};

// Enable debug in dev console: localStorage.setItem('xln-debug', 'true')
// Disable debug: localStorage.removeItem('xln-debug')