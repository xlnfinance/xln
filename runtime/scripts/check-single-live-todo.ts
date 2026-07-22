import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const REQUIRED_LIVE_TODO = 'todo.md';
const LIVE_TODO_MARKER = 'only live TODO/NEXT file';
const GENERATED_OR_VENDOR_DIRS = new Set([
  '.git',
  '.logs',
  '.svelte-kit',
  '.svelte-kit-e2e',
  'build',
  'db',
  'db-tmp',
  'node_modules',
  'playwright-report',
  'test-results',
]);
const GENERATED_PREFIXES = [
  `frontend${sep}build${sep}`,
  `frontend${sep}static${sep}`,
  `frontend${sep}ios${sep}App${sep}App${sep}public${sep}`,
  `frontend${sep}android${sep}app${sep}src${sep}main${sep}assets${sep}public${sep}`,
  `frontend${sep}.svelte-kit${sep}`,
  `frontend${sep}.svelte-kit-e2e${sep}`,
  `native${sep}extension${sep}dist${sep}`,
  `packages${sep}npm${sep}xlnfinance${sep}app${sep}`,
  `packages${sep}npm${sep}xlnfinance${sep}dist${sep}`,
];

const normalize = (path: string): string => path.split(sep).join('/');

const isGeneratedOrArchivePath = (relativePath: string): boolean => {
  if (relativePath.startsWith(`docs${sep}archive${sep}`)) return true;
  return GENERATED_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
};

const collectFiles = (directory: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (GENERATED_OR_VENDOR_DIRS.has(entry)) continue;
    const absolutePath = join(directory, entry);
    const relativePath = relative(ROOT, absolutePath);
    if (isGeneratedOrArchivePath(relativePath)) continue;
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      files.push(...collectFiles(absolutePath));
    } else {
      files.push(relativePath);
    }
  }
  return files;
};

const liveBacklogCandidates = collectFiles(ROOT)
  .map(normalize)
  .filter((path) => /(^|\/)(todo|next)\.md$/i.test(path));

const errors: string[] = [];

if (!existsSync(join(ROOT, REQUIRED_LIVE_TODO))) {
  errors.push(`${REQUIRED_LIVE_TODO} is missing`);
}

for (const path of liveBacklogCandidates) {
  if (path !== REQUIRED_LIVE_TODO) {
    errors.push(`stale live backlog candidate found: ${path}`);
  }
}

if (existsSync(join(ROOT, REQUIRED_LIVE_TODO))) {
  const body = Bun.file(join(ROOT, REQUIRED_LIVE_TODO)).text();
  const text = await body;
  if (!text.includes(LIVE_TODO_MARKER)) {
    errors.push(`${REQUIRED_LIVE_TODO} must declare itself as the ${LIVE_TODO_MARKER}`);
  }
}

if (errors.length > 0) {
  console.error('Single live TODO check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Single live TODO check passed (${REQUIRED_LIVE_TODO})`);
