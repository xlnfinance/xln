/**
 * Guardrail: enforce JAdapter abstraction boundary.
 *
 * Fails if scenario/runtime domain code reaches into direct EVM/RPC helpers
 * instead of going through JAdapter (submit/watch).
 */

import { promises as fs } from 'fs';
import path from 'path';

const ROOT = process.cwd();
const RUNTIME_DIR = path.join(ROOT, 'runtime');

const DIRECT_EVM_ALLOWLIST = new Set<string>([
  'runtime/evm.ts',
  'runtime/runtime.ts',
  'runtime/server.ts',
  'runtime/state-helpers.ts',
  'runtime/cli.ts',
  'runtime/j-batch.ts',
  'runtime/entity-factory.ts',
  'runtime/entity-tx/j-events.ts',
  'runtime/scenarios/boot.ts',
]);

const SCENARIO_FILE_ALLOWLIST = new Set<string>([
  'runtime/scenarios/boot.ts',
  'runtime/scenarios/jadapter-test.ts',
  'runtime/scenarios/jtest.ts',
  'runtime/scenarios/p2p-relay.ts',
]);

type Violation = {
  file: string;
  line: number;
  rule: string;
  snippet: string;
};

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walk(full));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

function toRel(file: string): string {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function findViolations(text: string, fileRel: string): Violation[] {
  const violations: Violation[] = [];

  const pushMatches = (regex: RegExp, rule: string): void => {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const idx = match.index ?? 0;
      const line = text.slice(0, idx).split('\n').length;
      const snippet = (match[0] || '').trim();
      violations.push({ file: fileRel, line, rule, snippet });
    }
  };

  const isScenarioFile = fileRel.startsWith('runtime/scenarios/');

  // Strict scenario boundary: scenario logic must stay adapter-driven.
  if (isScenarioFile && !SCENARIO_FILE_ALLOWLIST.has(fileRel)) {
    pushMatches(/\bensureBrowserVM\b/g, 'scenario-no-ensureBrowserVM');
    pushMatches(/\bconnectToEthereum\s*\(/g, 'scenario-no-connectToEthereum');
    pushMatches(/\bgetBrowserVMInstance\s*\(/g, 'scenario-no-getBrowserVMInstance');
    pushMatches(/\bcreateBrowserVMAdapter\b/g, 'scenario-no-createBrowserVMAdapter');
    pushMatches(/\bBrowserVMEthersProvider\b/g, 'scenario-no-BrowserVMEthersProvider');
    pushMatches(/new\s+ethers\.JsonRpcProvider\s*\(/g, 'scenario-no-direct-JsonRpcProvider');
    pushMatches(/from\s+['"][^'"]*\/evm(?:\.ts)?['"]/g, 'scenario-no-evm-import');
    pushMatches(/import\s*\(\s*['"][^'"]*\/evm(?:\.ts)?['"]\s*\)/g, 'scenario-no-dynamic-evm-import');
  }

  // Runtime boundary: direct EVM hooks are allowlisted-only.
  if (!DIRECT_EVM_ALLOWLIST.has(fileRel)) {
    pushMatches(/\bconnectToEthereum\s*\(/g, 'runtime-allowlist-connectToEthereum');
    pushMatches(/\bgetBrowserVMInstance\s*\(/g, 'runtime-allowlist-getBrowserVMInstance');
    pushMatches(/new\s+ethers\.JsonRpcProvider\s*\(/g, 'runtime-allowlist-direct-JsonRpcProvider');
    pushMatches(/from\s+['"][^'"]*\/evm(?:\.ts)?['"]/g, 'runtime-allowlist-evm-import');
    pushMatches(/import\s*\(\s*['"][^'"]*\/evm(?:\.ts)?['"]\s*\)/g, 'runtime-allowlist-dynamic-evm-import');
  }

  // Batch submit path: should go through entity j_broadcast -> runtime jOutbox.
  if (fileRel !== 'runtime/j-batch.ts' && fileRel !== 'runtime/evm.ts') {
    pushMatches(/\bbroadcastBatch\s*\(/g, 'runtime-no-direct-broadcastBatch-call');
  }

  return violations;
}

async function main(): Promise<void> {
  const files = await walk(RUNTIME_DIR);
  const scoped = files
    .map(toRel)
    .filter((f) => !f.startsWith('runtime/jadapter/'))
    .filter((f) => !f.includes('runtime-check.js'));

  const violations: Violation[] = [];

  for (const fileRel of scoped) {
    const abs = path.join(ROOT, fileRel);
    const text = await fs.readFile(abs, 'utf8');
    violations.push(...findViolations(text, fileRel));
  }

  if (violations.length > 0) {
    console.error('❌ JAdapter boundary violations detected:\n');
    for (const v of violations) {
      console.error(`- ${v.file}:${v.line} [${v.rule}] ${v.snippet}`);
    }
    process.exit(1);
  }

  console.log(`✅ JAdapter boundary check passed (${scoped.length} files scanned)`);
}

main().catch((err) => {
  console.error('❌ check-jadapter-boundary failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
