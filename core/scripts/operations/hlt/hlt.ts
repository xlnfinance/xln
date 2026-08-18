#!/usr/bin/env bun

/**
 * Production swap-load CLI. Workloads use separate Hub, MM and load Runtime
 * processes with relay P2P, Anvil and durable LevelDB/WAL; only committed Hub
 * trade counters and frame roots authorize successful completion.
 */

import { parseWorkerArgs } from './worker-runtime';
import { runSameProductionSwapLoad } from './workload/worker-same';
import { runCrossProductionSwapLoad } from './cross/worker-cross';
import { runCrossProductionRecovery } from './cross/worker-cross-recovery';

const args = parseWorkerArgs(process.argv.slice(2));
if (args.mode === 'same') await runSameProductionSwapLoad(args);
else if (args.mode === 'cross') await runCrossProductionSwapLoad(args);
else if (args.mode === 'cross-recovery') await runCrossProductionRecovery(args);
else throw new Error(`PRODUCTION_SWAP_LOAD_MODE_NOT_IMPLEMENTED:${args.mode}`);
