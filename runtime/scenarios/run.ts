/**
 * CLI runner for scenarios — configurable backend (browservm | rpc)
 *
 * Usage:
 *   bun runtime/scenarios/run.ts lock-ahb                    # RPC (default)
 *   bun runtime/scenarios/run.ts lock-ahb --mode=rpc         # Local Anvil
 *   bun runtime/scenarios/run.ts lock-ahb --mode=rpc --rpc=http://127.0.0.1:8545
 */

const SCENARIOS: Record<string, { file: string; fn: string }> = {
  'rebalance': { file: './rebalance', fn: 'runRebalanceScenario' },
  'lock-ahb':  { file: './lock-ahb',  fn: 'lockAhb' },
  'ahb':       { file: './ahb',       fn: 'ahb' },
  'swap':      { file: './swap',      fn: 'swap' },
  'settle':    { file: './settle',    fn: 'runSettleScenario' },
  'htlc-4hop': { file: './htlc-4hop', fn: 'htlc4hop' },
  'grid':              { file: './grid',              fn: 'grid' },
  'settle-rebalance':  { file: './settle-rebalance',  fn: 'runSettleRebalance' },
  'processbatch':      { file: './processbatch',      fn: 'runProcessBatchScenario' },
  'process-batch':     { file: './processbatch',      fn: 'runProcessBatchScenario' },
};

function parseArgs(): { scenario: string; mode?: string; rpc?: string } {
  const args = process.argv.slice(2);
  const scenario = args.find(a => !a.startsWith('--'));
  if (!scenario) {
    console.log('Usage: bun runtime/scenarios/run.ts <scenario> [--mode=browservm|rpc] [--rpc=URL]');
    console.log(`\nAvailable scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  const getFlag = (name: string): string | undefined => {
    const eqArg = args.find(a => a.startsWith(`--${name}=`));
    if (eqArg) return eqArg.split('=')[1];
    const idx = args.findIndex(a => a === `--${name}`);
    if (idx >= 0 && idx + 1 < args.length) {
      const value = args[idx + 1];
      if (value && !value.startsWith('--')) return value;
    }
    return undefined;
  };

  return { scenario, mode: getFlag('mode'), rpc: getFlag('rpc') };
}

async function main() {
  const { scenario, mode, rpc } = parseArgs();

  const entry = SCENARIOS[scenario];
  if (!entry) {
    console.error(`Unknown scenario: "${scenario}". Available: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  // Set env vars — scenarios read these via getJAdapterMode() / ensureJAdapter()
  if (mode) process.env.JADAPTER_MODE = mode;
  if (rpc) process.env.ANVIL_RPC = rpc;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Scenario: ${scenario}`);
  console.log(`  Mode: ${mode || process.env.JADAPTER_MODE || 'rpc'}`);
  if (rpc) console.log(`  RPC: ${rpc}`);
  console.log(`${'='.repeat(60)}\n`);

  // Create fresh env — scenario self-boots from here
  const { createEmptyEnv } = await import('../runtime');
  const env = createEmptyEnv(`${scenario}-cli-seed-42`);

  // Dynamic import and run
  const mod = await import(entry.file);
  const fn = mod[entry.fn];
  if (!fn) {
    console.error(`Function "${entry.fn}" not found in ${entry.file}`);
    process.exit(1);
  }

  await fn(env);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${scenario} COMPLETE`);
  console.log(`  Frames: ${env.history?.length || 0}`);
  console.log(`${'='.repeat(60)}\n`);
  process.exit(0);
}

main().catch(err => {
  console.error('\nScenario FAILED:', err.message || err);
  process.exit(1);
});
