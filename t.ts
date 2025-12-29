import { createEmptyEnv } from './runtime/runtime.js';
import { ahb } from './runtime/scenarios/ahb.js';
const env = createEmptyEnv();
await ahb(env);
console.log('First 5 timestamps:', env.history.slice(0,5).map(f => f.timestamp));
console.log('Last 5 timestamps:', env.history.slice(-5).map(f => f.timestamp));
