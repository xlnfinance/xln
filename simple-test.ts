import { createEmptyEnv } from './runtime/runtime.js';
import { process } from './runtime/runtime.js';

const env = createEmptyEnv();
env.scenarioMode = true;
env.timestamp = Date.now();

for (let i = 0; i < 5; i++) {
  await process(env);
  console.log(`Frame ${i}: timestamp=${env.timestamp}, history=${env.history.length}`);
}
