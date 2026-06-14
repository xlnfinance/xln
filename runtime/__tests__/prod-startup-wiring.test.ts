import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

describe('production startup wiring', () => {
  test('start-server exposes the secondary Tron RPC to the orchestrator and children', () => {
    const script = readFileSync(join(repoRoot, 'scripts/start-server.sh'), 'utf8');
    expect(script).toContain('RPC2_PORT="${ANVIL2_PORT:-$(xln_rpc2_port)}"');
    expect(script).toContain('export ANVIL_RPC2="${ANVIL_RPC2:-http://127.0.0.1:${RPC2_PORT}}"');
    expect(script).toContain('export RPC_TRON="${RPC_TRON:-$ANVIL_RPC2}"');
    expect(script).toContain('export RELAY_URL=${RELAY_URL:-$INTERNAL_RELAY_URL}');
    expect(script).toContain('--relay-url "$RELAY_URL"');
    expect(script).toContain('--rpc2-url "$ANVIL_RPC2"');
    expect(script).toContain('export XLN_RUNTIME_EXIT_ON_FATAL=${XLN_RUNTIME_EXIT_ON_FATAL:-1}');
    expect(script).toContain('export XLN_STORAGE_WRITE_TIMEOUT_MS=${XLN_STORAGE_WRITE_TIMEOUT_MS:-15000}');

    const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const orchestratorConfig = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator-config.ts'), 'utf8');
    expect(orchestratorConfig).toContain("relayUrl: normalizeWsUrl(getArg('--relay-url', process.env['RELAY_URL'] || '')");
    expect(orchestrator).toContain('const relayUrl = args.relayUrl;');
    expect(orchestrator).toContain("process.env['XLN_CHILD_HEALTH_TIMEOUT_MS'] || '10000'");
    expect(orchestrator).toContain('syncCanonicalJurisdictionsFromShard(jurisdictionsConfig)');
    expect(orchestrator).toContain("...(args.rpc2Url ? ['--rpc2-url', args.rpc2Url] : [])");
    expect(orchestrator).toContain("XLN_RUNTIME_EXIT_ON_FATAL: process.env['XLN_RUNTIME_EXIT_ON_FATAL'] ?? '1'");
    expect(orchestrator).toContain("XLN_STORAGE_WRITE_TIMEOUT_MS: process.env['XLN_STORAGE_WRITE_TIMEOUT_MS'] ?? '15000'");
    expect(orchestrator).toContain("XLN_STORAGE_SYNC_WRITES: process.env['XLN_STORAGE_SYNC_WRITES'] ?? '0'");
    expect(orchestrator).toContain("XLN_MARKET_MAKER_DISABLE_STORAGE: process.env['XLN_MARKET_MAKER_DISABLE_STORAGE'] ?? '1'");

    const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
    const mmNode = readFileSync(join(repoRoot, 'runtime/orchestrator/mm-node.ts'), 'utf8');
    expect(hubNode).toContain("rpc2Url: getArg('--rpc2-url', '')");
    expect(hubNode).toContain('visibleDirectSupportPeers');
    expect(mmNode).toContain("rpc2Url: getArg('--rpc2-url', '')");
    expect(mmNode).toContain('Runtime storage disabled for rebuildable market-maker state');
  });

  test('deploy starts and checks the production Tron chain', () => {
    const deploy = readFileSync(join(repoRoot, 'deploy.sh'), 'utf8');
    expect(deploy).toContain('pm2 start scripts/start-anvil2.sh --name anvil2');
    expect(deploy).toContain('wait_for_rpc_chain "http://127.0.0.1:8546" "0x7a6a"');
    expect(deploy).toContain('fail_deploy_with_debug "anvil2 did not become ready on :8546"');
  });

  test('secondary anvil uses a persistent Tron chain id and state file', () => {
    const anvil = readFileSync(join(repoRoot, 'scripts/start-anvil.sh'), 'utf8');
    const anvil2 = readFileSync(join(repoRoot, 'scripts/start-anvil2.sh'), 'utf8');
    expect(anvil).toContain('ANVIL_CHAIN_ID="${ANVIL_CHAIN_ID:-31337}"');
    expect(anvil).toContain('--chain-id "$ANVIL_CHAIN_ID"');
    expect(anvil2).toContain('ANVIL_CHAIN_ID="${ANVIL2_CHAIN_ID:-31338}"');
    expect(anvil2).toContain('ANVIL_STATE="${ANVIL2_STATE:-$REPO_ROOT/data/anvil2-state.json}"');
  });
});
