import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FEATURED_DOC_IDS,
  READING_PATHS,
  classifyDoc,
  getDocOrder,
  getSectionDefinitions,
  getSectionKind,
  getSectionMeta,
  getSectionOrder,
  isFeaturedDoc,
  normalizeDocId,
} from '../docs-catalog.js';
import {
  DOCS_CATALOG_SCHEMA_VERSION,
  parseDocsCatalogManifest,
} from '../packages/client-core/docs-catalog-contract.js';
import type {
  DocsCatalogManifest,
  DocsCatalogEntry,
} from '../packages/client-core/docs-catalog-contract.js';

type SourceFile = Readonly<{ path: string; bytes: Buffer; sha256: string }>;
type BuiltDocsCatalog = Readonly<{ files: readonly SourceFile[]; manifest: DocsCatalogManifest }>;
type DocMeta = Readonly<{ title: string; summary: string; role: string; status: string; audience: string }>;

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const slashPath = (value: string): string => value.replaceAll('\\', '/');

const validateFrontmatter = (content: string, path: string): void => {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') return;
  const end = lines.slice(1).findIndex(line => line === '---');
  if (end < 0) throw new Error(`DOCS_FRONTMATTER_UNTERMINATED:${path}`);
  const keys = new Set<string>();
  lines.slice(1, end + 1).forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) throw new Error(`DOCS_FRONTMATTER_MALFORMED:${path}:${index + 2}`);
    const key = match[1];
    if (!key) throw new Error(`DOCS_FRONTMATTER_KEY_MISSING:${path}:${index + 2}`);
    if (keys.has(key)) throw new Error(`DOCS_FRONTMATTER_DUPLICATE_KEY:${path}:${key}`);
    keys.add(key);
  });
};

const walkSourceFiles = (sourceRoot: string): readonly SourceFile[] => {
  const files: SourceFile[] = [];
  const visit = (directory: string): void => {
    readdirSync(directory).toSorted((left, right) => left.localeCompare(right)).forEach(name => {
      const path = join(directory, name);
      const relativePath = slashPath(relative(sourceRoot, path));
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) throw new Error(`DOCS_SOURCE_SYMLINK_REJECTED:${relativePath}`);
      if (stats.isDirectory()) return visit(path);
      if (!stats.isFile()) throw new Error(`DOCS_SOURCE_ENTRY_UNSUPPORTED:${relativePath}`);
      if (!relativePath || relativePath.startsWith('../') || relativePath.includes('/../')) {
        throw new Error(`DOCS_SOURCE_PATH_TRAVERSAL:${relativePath}`);
      }
      const bytes = readFileSync(path);
      files.push({ path: relativePath, bytes, sha256: sha256(bytes) });
    });
  };
  visit(sourceRoot);
  return files;
};

const stripMarkdownDecorators = (text: string | undefined): string => String(text || '')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/\*([^*]+)\*/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/\s+/g, ' ')
  .trim();

export const extractDocMeta = (content: string, docId: string): DocMeta => {
  validateFrontmatter(content, `${docId}.md`);
  const lines = content.split(/\r?\n/);
  const titleLine = lines.find(line => /^#\s+/.test(line));
  const title = stripMarkdownDecorators(
    titleLine ? titleLine.replace(/^#\s+/, '') : docId.split('/').at(-1)?.replace(/[-_]/g, ' ') || docId,
  );
  let role = '';
  let status = '';
  let audience = '';
  let activeMetaField = '';
  for (const line of lines.slice(0, 32)) {
    const trimmed = line.trim();
    const match = trimmed.match(/^\*\*(Role|Status|Audience):\*\*\s*(.*)$/);
    const plainStatus = trimmed.match(/^Status:\s*(.*)$/);
    if (match) {
      const field = match[1];
      if (!field) throw new Error(`DOCS_METADATA_FIELD_MISSING:${docId}`);
      activeMetaField = field.toLowerCase();
      const value = stripMarkdownDecorators(match[2]);
      if (activeMetaField === 'role') role = value;
      if (activeMetaField === 'status') status = value;
      if (activeMetaField === 'audience') audience = value;
      continue;
    }
    if (!status && plainStatus) {
      status = stripMarkdownDecorators(plainStatus[1]);
      activeMetaField = 'status';
      continue;
    }
    if (!trimmed || /^#/.test(trimmed) || /^\*\*[A-Za-z]+:\*\*/.test(trimmed)) {
      activeMetaField = '';
      continue;
    }
    if (activeMetaField === 'role') role = stripMarkdownDecorators(`${role} ${trimmed}`);
    if (activeMetaField === 'status') status = stripMarkdownDecorators(`${status} ${trimmed}`);
    if (activeMetaField === 'audience') audience = stripMarkdownDecorators(`${audience} ${trimmed}`);
  }

  let summary = '';
  let paragraph: string[] = [];
  let inCodeBlock = false;
  const skipLine = (line: string): boolean => {
    const trimmed = line.trim();
    return Boolean(trimmed) && (
      /^#/.test(trimmed) || /^\*\*\[/.test(trimmed) || /^\*\*(Role|Status|Audience):\*\*/.test(trimmed)
      || /^(Status|Scope|Audience):/.test(trimmed) || /^\[pairing:/i.test(trimmed) || /^<img\b/i.test(trimmed)
      || /^[|:-]+$/.test(trimmed) || /^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)
    );
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    if (!trimmed || skipLine(line)) {
      if (paragraph.length > 0) {
        const candidate = stripMarkdownDecorators(paragraph.join(' '));
        paragraph = [];
        if (candidate) {
          summary = candidate;
          break;
        }
      }
      continue;
    }
    paragraph.push(trimmed);
  }
  if (!summary && paragraph.length > 0) summary = stripMarkdownDecorators(paragraph.join(' '));
  if (summary.length > 220) summary = `${summary.slice(0, 217).trimEnd()}...`;
  return { title, summary, role, status, audience };
};

export const buildDocsCatalog = (sourceRootInput: string): BuiltDocsCatalog => {
  const sourceRoot = resolve(sourceRootInput);
  if (!existsSync(sourceRoot)) throw new Error(`DOCS_SOURCE_ROOT_MISSING:${sourceRoot}`);
  const sourceStats = lstatSync(sourceRoot);
  if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) {
    throw new Error(`DOCS_SOURCE_ROOT_INVALID:${sourceRoot}`);
  }
  const files = walkSourceFiles(sourceRoot);
  const markdownFiles = files.filter(file => extname(file.path).toLowerCase() === '.md');
  const ids = new Set();
  const urls = new Set();
  const items = markdownFiles.map(file => {
    const docId = normalizeDocId(file.path);
    const url = `/docs?doc=${encodeURIComponent(docId)}`;
    if (ids.has(docId)) throw new Error(`DOCS_DOCUMENT_ID_DUPLICATE:${docId}`);
    if (urls.has(url)) throw new Error(`DOCS_DOCUMENT_URL_DUPLICATE:${url}`);
    ids.add(docId);
    urls.add(url);
    const content = file.bytes.toString('utf8');
    const meta = extractDocMeta(content, docId);
    const sectionId = classifyDoc(docId);
    const section = getSectionMeta(sectionId);
    return {
      id: docId,
      path: file.path,
      title: meta.title,
      summary: meta.summary,
      role: meta.role,
      status: meta.status,
      audience: meta.audience,
      kind: getSectionKind(sectionId),
      sectionId,
      sectionTitle: section?.title || 'Other',
      featured: isFeaturedDoc(docId),
      order: getDocOrder(docId),
      sectionOrder: getSectionOrder(sectionId),
      url,
      sha256: file.sha256,
    };
  }).toSorted((left, right) => (
    left.sectionOrder - right.sectionOrder || left.order - right.order || left.title.localeCompare(right.title)
  ));
  const byId = new Map(items.map(item => [item.id, item]));
  const sections = getSectionDefinitions().map(section => ({
    id: section.id,
    title: section.title,
    description: section.description,
    kind: section.kind,
    order: section.order,
    items: items.filter(item => item.sectionId === section.id),
  })).filter(section => section.items.length > 0);
  const manifest = {
    schemaVersion: DOCS_CATALOG_SCHEMA_VERSION,
    contentSha256: sha256(JSON.stringify(files.map(file => ({ path: file.path, sha256: file.sha256 })))),
    counts: {
      total: items.length,
      live: items.filter(item => item.kind === 'live').length,
      archive: items.filter(item => item.kind === 'archive').length,
    },
    featured: FEATURED_DOC_IDS.map(id => byId.get(id)).filter((entry): entry is DocsCatalogEntry => entry !== undefined),
    readingPaths: READING_PATHS.map(path => ({
      ...path,
      items: path.items.map(id => byId.get(id)).filter((entry): entry is DocsCatalogEntry => entry !== undefined),
    })),
    sections,
    items,
  };
  return { files, manifest: parseDocsCatalogManifest(manifest) };
};

export const produceDocsCatalog = (sourceRootInput: string, outputRootInput: string): DocsCatalogManifest => {
  const sourceRoot = resolve(sourceRootInput);
  const outputRoot = resolve(outputRootInput);
  if (sourceRoot === outputRoot || outputRoot.startsWith(`${sourceRoot}${sep}`) || sourceRoot.startsWith(`${outputRoot}${sep}`)) {
    throw new Error(`DOCS_ROOTS_OVERLAP:${sourceRoot}:${outputRoot}`);
  }
  if (outputRoot === resolve(outputRoot, '..')) throw new Error(`DOCS_OUTPUT_ROOT_INVALID:${outputRoot}`);
  const { files, manifest } = buildDocsCatalog(sourceRoot);
  const stagingRoot = `${outputRoot}.next-${process.pid}`;
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });
  try {
    files.forEach(file => {
      const destination = join(stagingRoot, file.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, file.bytes);
    });
    writeFileSync(join(stagingRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    rmSync(outputRoot, { recursive: true, force: true });
    renameSync(stagingRoot, outputRoot);
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  return manifest;
};

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const isCli = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const input = argument('--input');
  const output = argument('--output');
  if (!input || !output) throw new Error('DOCS_PRODUCER_USAGE:--input <directory> --output <directory>');
  const manifest = produceDocsCatalog(input, output);
  console.log(`DOCS_CATALOG_GENERATED docs=${manifest.counts.total} sha256=${manifest.contentSha256}`);
}
