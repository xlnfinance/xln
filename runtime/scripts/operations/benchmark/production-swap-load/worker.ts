#!/usr/bin/env bun

/**
 * Production swap-load CLI. Workloads use separate Hub, MM and load Runtime
 * processes with relay P2P, Anvil and durable LevelDB/WAL; only committed Hub
 * trade counters and frame roots authorize successful completion.
 */

import { parseWorkerArgs } from './worker-runtime';
import { runSameProductionSwapLoad } from './worker-same';

const args = parseWorkerArgs(process.argv.slice(2));
if (args.mode !== 'same') throw new Error(`PRODUCTION_SWAP_LOAD_MODE_NOT_IMPLEMENTED:${args.mode}`);
await runSameProductionSwapLoad(args);
