import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  resolveBootstrapFunderIndex,
  resolveFaucetFunderIndex,
  STACK_MANAGER_E2E_FUNDER_INDEX,
} from '../../../orchestrator/support/anvil-dev-accounts';

const CORE_ROOT = join(import.meta.dir, '../../..');

const listSources = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return listSources(path);
    return name.endsWith('.ts') ? [path] : [];
  });

describe('Anvil dev account ownership', () => {
  test('operators, faucet funders and the bootstrap funder never share an EOA', () => {
    for (const hubCount of [1, 2, 3, 4]) {
      const operators = Array.from({ length: hubCount }, (_, index) => index);
      const faucets = operators.map(index => resolveFaucetFunderIndex(index, hubCount));
      const all = [...operators, ...faucets, resolveBootstrapFunderIndex(hubCount), STACK_MANAGER_E2E_FUNDER_INDEX];
      expect(new Set(all).size).toBe(all.length);
      expect(Math.max(...all)).toBeLessThan(10);
    }
    expect(resolveBootstrapFunderIndex(3)).toBe(6);
  });

  test('a topology without a free genesis funder is refused', () => {
    // Four Hubs skip the Stack Manager spec's reserved account 5.
    expect(resolveBootstrapFunderIndex(4)).toBe(4);
    expect(() => resolveBootstrapFunderIndex(5)).toThrow('BOOTSTRAP_FUNDER_INDEX_COLLIDES:hubs=5');
    expect(() => resolveBootstrapFunderIndex(0)).toThrow('BOOTSTRAP_FUNDER_INDEX_COLLIDES:hubs=0');
  });

  // anvil_setBalance rewrites state under the sealed latest header, so the J
  // watcher's eth_getProof audit at that height fails with
  // STATE_PROOF_NODE_HASH_MISMATCH (MM fail-stop in the E2E mesh, 2026-10-26).
  test('core production code never rewrites dev-chain state outside a mined block', () => {
    const callers = listSources(CORE_ROOT)
      .filter(path => /['"]anvil_setBalance['"]/.test(readFileSync(path, 'utf8')))
      .map(path => relative(CORE_ROOT, path));
    expect(callers).toEqual([]);
  });
});
