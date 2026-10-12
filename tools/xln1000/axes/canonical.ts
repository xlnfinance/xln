/** S: one implementation per role. A frozen or deferred implementation still counts until its code is deleted. */
import { isTestPath, type FileInfo } from '../ast';
import { clamp01, gap, type Axis } from '../model';
import { sumLines, type Repo } from '../repo';

type Status = 'canonical' | 'active' | 'frozen' | 'deferred';
type Implementation = Readonly<{ label: string; paths: readonly string[]; extension?: RegExp; status: Status }>;

const RUST = /\.rs$/;
const COUNTED_LINES = 1000;
const IGNORED_HELPER_NAMES = new Set(['main', 'run', 'usage']);

/** Path manifest (owner-only). Statuses follow the 2026-10-11 scope cut; they label, they do not discount. */
const ROLES: Readonly<Record<string, readonly Implementation[]>> = {
  'account/entity execution engine': [
    { label: 'TS in-thread (core/account+entity)', paths: ['core/account', 'core/entity'], status: 'canonical' },
    { label: 'TS worker (core/runtime/workers/account)', paths: ['core/runtime/workers/account'], status: 'active' },
    {
      label: 'Rust (rscore/crates engine+entity-kernel+runtime+batch)',
      paths: ['rscore/crates/engine', 'rscore/crates/entity-kernel', 'rscore/crates/runtime', 'rscore/crates/batch'],
      extension: RUST,
      status: 'frozen',
    },
  ],
  'consumer wallet UI': [
    {
      label: 'Svelte wallet (frontend/src/lib/components/Entity)',
      paths: ['frontend/src/lib/components/Entity'],
      status: 'frozen',
    },
    { label: 'React wallet (ui/src)', paths: ['ui/src'], status: 'canonical' },
    { label: 'SwiftUI (frontend/ios)', paths: ['frontend/ios'], extension: /\.swift$/, status: 'deferred' },
  ],
  'jurisdiction adapter': [
    { label: 'rpc (core/jurisdiction/adapter/rpc)', paths: ['core/jurisdiction/adapter/rpc'], status: 'canonical' },
    {
      label: 'browservm (core/jurisdiction/adapter/browservm)',
      paths: ['core/jurisdiction/adapter/browservm'],
      status: 'active',
    },
  ],
  'runtime-adapter API server': [
    { label: 'TS (core/api/runtime-adapter)', paths: ['core/api/runtime-adapter'], status: 'canonical' },
    {
      label: 'Rust (rscore/crates/process/src/runtime_adapter)',
      paths: ['rscore/crates/process/src/runtime_adapter'],
      extension: RUST,
      status: 'frozen',
    },
  ],
};

const implementationLines = (repo: Repo, implementation: Implementation): number =>
  sumLines(
    repo,
    implementation.paths,
    path => !isTestPath(path) && (!implementation.extension || implementation.extension.test(path)),
  );

const measureRoles = (repo: Repo) =>
  Object.entries(ROLES).map(([role, implementations]) => {
    const rows = implementations.map(item => ({
      label: item.label,
      status: item.status,
      lines: implementationLines(repo, item),
    }));
    const counted = rows.filter(row => row.lines >= COUNTED_LINES);
    return { role, rows, count: counted.length, counted: counted.map(row => `${row.label} [${row.status}]`) };
  });

/** Top-level helper names defined in two or more production files (name match only). */
const duplicateHelpers = (info: ReadonlyMap<string, FileInfo>) => {
  const files = new Map<string, Set<string>>();
  for (const file of info.values()) {
    if (/^core\/(scripts|scenarios)\//.test(file.path)) continue;
    for (const name of file.topNames.filter(item => !IGNORED_HELPER_NAMES.has(item))) {
      files.set(name, (files.get(name) ?? new Set()).add(file.path));
    }
  }
  return [...files]
    .filter(([, paths]) => paths.size >= 2)
    .map(([name, paths]) => ({ name, defs: paths.size }))
    .sort((left, right) => right.defs - left.defs || left.name.localeCompare(right.name));
};

export const measureCanonical = (repo: Repo, info: ReadonlyMap<string, FileInfo>): Axis => {
  const roles = measureRoles(repo);
  const rolesScore = roles.reduce((sum, role) => sum + 1 / Math.max(1, role.count), 0) / roles.length;
  const duplicates = duplicateHelpers(info);
  const duplicateExcess = duplicates.reduce((sum, item) => sum + item.defs - 1, 0);
  const sub = { roles: rolesScore, helpers: clamp01(1 - duplicateExcess / 400) };
  const score = 90 * (0.7 * sub.roles + 0.3 * sub.helpers);
  const roleGaps = roles
    .filter(role => role.count > 1)
    .map(role =>
      gap(
        'S',
        `one ${role.role} (counted: ${role.counted.join(', ')})`,
        ((90 * 0.7) / roles.length) * (1 - 1 / role.count),
      ),
    );
  const gaps = [
    ...roleGaps,
    gap('S', `deduplicate helpers (${String(duplicateExcess)} extra definitions)`, 27 * (1 - sub.helpers)),
  ];
  const raw = {
    roles,
    duplicateTopLevelNames: duplicates.length,
    duplicateExcessDefs: duplicateExcess,
    topDuplicates: duplicates.slice(0, 15),
  };
  return { id: 'S', name: 'Single canonical path', weight: 90, score, ceiling: score, sub, gaps, vetoes: [], raw };
};
