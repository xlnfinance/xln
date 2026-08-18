import { dirname, join, normalize } from 'node:path';
import { readFileSync } from 'node:fs';

type KnipSymbol = { name: string };
type KnipIssue = {
  file: string;
  cycles?: string[];
  enumMembers?: KnipSymbol[];
  exports?: KnipSymbol[];
  namespaceMembers?: KnipSymbol[];
  nsExports?: KnipSymbol[];
  nsTypes?: KnipSymbol[];
  types?: KnipSymbol[];
};

type KnipReport = { issues?: KnipIssue[] };

type ExternalRuntimeConsumer = {
  consumer: string;
  specifier: string;
  downstream?: { consumer: string; specifier: string };
};

const EXTERNAL_RUNTIME_CONSUMERS: Readonly<Record<string, readonly ExternalRuntimeConsumer[]>> = {
  'core/api/server/rpc/proxy-safety.ts': [{
    consumer: 'frontend/src/routes/rpc-proxy-safety.ts',
    specifier: '@xln/core/api/server/rpc/proxy-safety',
    downstream: {
      consumer: 'frontend/src/routes/rpc/+server.ts',
      specifier: '../rpc-proxy-safety',
    },
  }, {
    consumer: 'frontend/src/routes/rpc-proxy-safety.ts',
    specifier: '@xln/core/api/server/rpc/proxy-safety',
    downstream: {
      consumer: 'frontend/src/routes/rpc2/+server.ts',
      specifier: '../rpc-proxy-safety',
    },
  }],
  'core/config/constants.ts': [{
    consumer: 'frontend/src/lib/view/core/TimeMachine.svelte',
    specifier: '@xln/core/config/constants',
  }],
  'core/network/relay/market/wire.ts': [{
    consumer: 'frontend/src/lib/components/Trading/OrderbookPanel.svelte',
    specifier: '@xln/core/network/relay/market/wire',
  }],
  'core/network/relay/market/cap/market-cap-wire.ts': [{
    consumer: 'frontend/src/routes/market-cap/+page.svelte',
    specifier: '@xln/core/network/relay/market/cap/market-cap-wire',
  }],
  'core/qa/report-types.ts': [{
    consumer: 'core/qa/types.ts',
    specifier: './report-types',
    downstream: {
      consumer: 'frontend/src/lib/qa/types.ts',
      specifier: '@xln/core/qa/types',
    },
  }],
  'core/qa/severity.ts': [{
    consumer: 'frontend/src/routes/health/+page.svelte',
    specifier: '@xln/core/qa/severity',
  }],
  'core/qa/types.ts': [{
    consumer: 'frontend/src/lib/qa/types.ts',
    specifier: '@xln/core/qa/types',
  }],
};

type NamedBinding = { localName: string; reexport: boolean };

export const findNamedBinding = (source: string, specifier: string, symbol: string): NamedBinding | null => {
  const importPattern = /(?:import|export)\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) {
    if (match[2] !== specifier) continue;
    for (const part of (match[1] ?? '').split(',')) {
      const [imported, local] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      if (imported !== symbol) continue;
      return {
        localName: local?.trim() || imported,
        reexport: match[0].trimStart().startsWith('export'),
      };
    }
  }
  return null;
};

export const usesNamedBinding = (source: string, binding: NamedBinding): boolean => {
  if (binding.reexport) return false;
  const withoutModuleStatements = source.replace(
    /(?:import|export)\s+(?:type\s+)?\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];?/g,
    '',
  );
  const codeOnly = withoutModuleStatements
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '')
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
  const escaped = binding.localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(codeOnly);
};

export const resolveProofTarget = (consumer: string, specifier: string): string => {
  if (specifier.startsWith('@xln/')) return `${specifier.slice('@xln/'.length)}.ts`;
  return normalize(join(dirname(consumer), `${specifier}.ts`));
};

const provesConsumer = (
  repoRoot: string,
  sourceFile: string,
  proof: ExternalRuntimeConsumer,
  symbol: string,
): boolean => {
  if (resolveProofTarget(proof.consumer, proof.specifier) !== sourceFile) return false;
  const consumer = readFileSync(join(repoRoot, proof.consumer), 'utf8');
  const binding = findNamedBinding(consumer, proof.specifier, symbol);
  if (!binding) return false;
  if (!proof.downstream) return usesNamedBinding(consumer, binding);
  if (!binding.reexport) return false;
  if (resolveProofTarget(proof.downstream.consumer, proof.downstream.specifier) !== proof.consumer) return false;
  const downstream = readFileSync(join(repoRoot, proof.downstream.consumer), 'utf8');
  const downstreamBinding = findNamedBinding(downstream, proof.downstream.specifier, symbol);
  return downstreamBinding !== null && usesNamedBinding(downstream, downstreamBinding);
};

const provenConsumerIndexes = (repoRoot: string, key: string): number[] => {
  const match = /^(.+)::(?:export|nsExport|type|nsType|enum|namespace):(.+)$/.exec(key);
  if (!match) return [];
  const [, file = '', symbol = ''] = match;
  const proofs = EXTERNAL_RUNTIME_CONSUMERS[file];
  return proofs?.flatMap((proof, index) =>
    provesConsumer(repoRoot, file, proof, symbol) ? [index] : [],
  ) ?? [];
};

const symbolKeys = (file: string, kind: string, values: readonly KnipSymbol[] = []): string[] =>
  values.map(value => `${file}::${kind}:${value.name}`);

export const collectUnusedSurface = (report: KnipReport): string[] =>
  (report.issues ?? []).flatMap(issue => [
    ...symbolKeys(issue.file, 'export', issue.exports),
    ...symbolKeys(issue.file, 'nsExport', issue.nsExports),
    ...symbolKeys(issue.file, 'type', issue.types),
    ...symbolKeys(issue.file, 'nsType', issue.nsTypes),
    ...symbolKeys(issue.file, 'enum', issue.enumMembers),
    ...symbolKeys(issue.file, 'namespace', issue.namespaceMembers),
    ...(issue.cycles ?? []).map(cycle => `${issue.file}::cycle:${cycle}`),
  ]).sort();

const run = (): void => {
  const repoRoot = join(import.meta.dir, '..', '..', '..', '..');
  const result = Bun.spawnSync({
    cmd: [
      'bunx', 'knip', '--no-progress', '--no-config-hints', '--reporter', 'json',
      '--include', 'exports,nsExports,types,nsTypes,enumMembers,namespaceMembers,cycles',
    ],
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`KNIP_UNUSED_SURFACE_EXEC_FAILED:${result.exitCode}:${result.stderr.toString()}`);
  }
  const report = JSON.parse(result.stdout.toString()) as KnipReport;
  const actual = collectUnusedSurface(report);
  const runtimeActual = actual.filter(key => key.startsWith('core/'));
  const provenEntries = new Set<string>();
  const externalRuntime = runtimeActual.filter(key => {
    const file = key.split('::', 1)[0] ?? '';
    const indexes = provenConsumerIndexes(repoRoot, key);
    for (const index of indexes) provenEntries.add(`${file}[${index}]`);
    return indexes.length > 0;
  });
  const runtimeDebt = runtimeActual.filter(key => !externalRuntime.includes(key));
  const nonRuntimeActual = actual.filter(key => !key.startsWith('core/'));
  const errors = [
    ...runtimeDebt.map(key => `UNUSED_RUNTIME_SURFACE:${key}`),
    ...Object.entries(EXTERNAL_RUNTIME_CONSUMERS).flatMap(([file, proofs]) =>
      proofs.flatMap((_, index) => {
        const entry = `${file}[${index}]`;
        return provenEntries.has(entry) ? [] : [`STALE_EXTERNAL_RUNTIME_PROOF:${entry}`];
      }),
    ),
    ...nonRuntimeActual.map(key => `UNUSED_NON_RUNTIME_SURFACE:${key}`),
  ];
  if (errors.length > 0) {
    throw new Error(`UNUSED_SURFACE_RATCHET_FAILED\n${errors.join('\n')}`);
  }
  console.log(
    `UNUSED_SURFACE_OK runtimeDebt=0 externalRuntime=${externalRuntime.length} ` +
    `nonRuntimeDebt=${nonRuntimeActual.length} new=0 stale=0`,
  );
};

if (import.meta.main) run();
