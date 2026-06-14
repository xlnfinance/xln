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
    expect(script).toContain('--rpc2-url "$ANVIL_RPC2"');
  });

  test('deploy starts and checks the production Tron chain', () => {
    const deploy = readFileSync(join(repoRoot, 'deploy.sh'), 'utf8');
    expect(deploy).toContain('pm2 start scripts/dev/run-anvil2.sh --name anvil2');
    expect(deploy).toContain('wait_for_rpc_chain "http://127.0.0.1:8546" "0x7a6a"');
    expect(deploy).toContain('fail_deploy_with_debug "anvil2 did not become ready on :8546"');
  });
});
