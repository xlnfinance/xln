#!/usr/bin/env node
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { dirname, extname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  FEATURED_DOC_IDS,
  READING_PATHS,
  classifyDoc,
  getSectionDefinitions,
  getSectionKind,
  getSectionMeta,
  getSectionOrder,
  getDocOrder,
  isFeaturedDoc,
  normalizeDocId,
} from './docs-catalog.js';

const FRONTEND_DIR = dirname(fileURLToPath(import.meta.url));
const fromFrontend = (...parts) => resolve(FRONTEND_DIR, ...parts);
const REPO_ROOT = resolve(FRONTEND_DIR, '..');

const files = [
  { src: '../jurisdictions/artifacts/contracts/Account.sol/Account.json', dest: 'static/contracts/Account.json' },
  { src: '../jurisdictions/artifacts/contracts/Depository.sol/Depository.json', dest: 'static/contracts/Depository.json' },
  { src: '../jurisdictions/artifacts/contracts/EntityProvider.sol/EntityProvider.json', dest: 'static/contracts/EntityProvider.json' },
  { src: '../jurisdictions/artifacts/contracts/DeltaTransformer.sol/DeltaTransformer.json', dest: 'static/contracts/DeltaTransformer.json' },
  { src: '../jurisdictions/artifacts/contracts/ERC20Mock.sol/ERC20Mock.json', dest: 'static/contracts/ERC20Mock.json' },
];

function ensureDir(pathname) {
  mkdirSync(pathname, { recursive: true });
}

function cleanDir(pathname) {
  rmSync(pathname, { recursive: true, force: true });
  ensureDir(pathname);
}

function copyContracts() {
  for (const file of files) {
    const srcPath = fromFrontend(file.src);
    const destPath = fromFrontend(file.dest);

    if (!existsSync(srcPath)) {
      console.log(`⚠️ Source file not found: ${file.src}`);
      continue;
    }

    ensureDir(dirname(destPath));
    copyFileSync(srcPath, destPath);
    console.log(`✅ Copied ${file.src} → ${file.dest}`);
  }
}

function copyScenarios() {
  const scenariosSrc = fromFrontend('../scenarios');
  const scenariosDest = fromFrontend('static/scenarios');

  try {
    const stats = lstatSync(scenariosDest);
    if (stats.isSymbolicLink()) {
      console.log('ℹ️  static/scenarios is symlinked - skipping copy');
      return;
    }
  } catch {
    // no-op
  }

  if (!existsSync(scenariosSrc)) return;
  ensureDir(scenariosDest);
  cpSync(scenariosSrc, scenariosDest, { recursive: true });
  console.log('✅ Copied scenarios/ → static/scenarios/');
}

function walkMarkdownFiles(rootDir) {
  const results = [];

  function visit(currentDir) {
    for (const entry of readdirSync(currentDir)) {
      const fullPath = join(currentDir, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (extname(entry).toLowerCase() !== '.md') continue;
      results.push(fullPath);
    }
  }

  visit(rootDir);
  return results.sort();
}

function stripMarkdownDecorators(text) {
  return String(text || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDocMeta(content, docId) {
  const lines = content.split(/\r?\n/);
  const titleLine = lines.find((line) => /^#\s+/.test(line));
  const title = stripMarkdownDecorators(
    titleLine ? titleLine.replace(/^#\s+/, '') : docId.split('/').at(-1)?.replace(/[-_]/g, ' ') || docId,
  );

  let role = '';
  let status = '';
  let audience = '';

  let activeMetaField = '';
  for (const line of lines.slice(0, 32)) {
    const trimmed = line.trim();
    const roleMatch = trimmed.match(/^\*\*Role:\*\*\s*(.*)$/);
    const statusMatch = trimmed.match(/^\*\*Status:\*\*\s*(.*)$/);
    const audienceMatch = trimmed.match(/^\*\*Audience:\*\*\s*(.*)$/);
    const plainStatusMatch = trimmed.match(/^Status:\s*(.*)$/);

    if (roleMatch) {
      role = stripMarkdownDecorators(roleMatch[1]);
      activeMetaField = 'role';
      continue;
    }
    if (statusMatch) {
      status = stripMarkdownDecorators(statusMatch[1]);
      activeMetaField = 'status';
      continue;
    }
    if (audienceMatch) {
      audience = stripMarkdownDecorators(audienceMatch[1]);
      activeMetaField = 'audience';
      continue;
    }
    if (!status && plainStatusMatch) {
      status = stripMarkdownDecorators(plainStatusMatch[1]);
      activeMetaField = 'status';
      continue;
    }

    if (!trimmed || /^#/.test(trimmed) || /^\*\*[A-Za-z]+:\*\*/.test(trimmed)) {
      activeMetaField = '';
      continue;
    }

    if (activeMetaField === 'role') role = stripMarkdownDecorators(`${role} ${trimmed}`.trim());
    if (activeMetaField === 'status') status = stripMarkdownDecorators(`${status} ${trimmed}`.trim());
    if (activeMetaField === 'audience') audience = stripMarkdownDecorators(`${audience} ${trimmed}`.trim());
  }

  let summary = '';
  let paragraph = [];
  let inCodeBlock = false;

  const skipLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^#/.test(trimmed)) return true;
    if (/^\*\*\[/.test(trimmed)) return true;
    if (/^\*\*(Role|Status|Audience):\*\*/.test(trimmed)) return true;
    if (/^(Status|Scope|Audience):/.test(trimmed)) return true;
    if (/^\[pairing:/i.test(trimmed)) return true;
    if (/^<img\b/i.test(trimmed)) return true;
    if (/^[|:-]+$/.test(trimmed)) return true;
    if (/^[-*]\s+/.test(trimmed)) return true;
    if (/^\d+\.\s+/.test(trimmed)) return true;
    return false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    if (!trimmed) {
      if (paragraph.length > 0) {
        const candidate = stripMarkdownDecorators(paragraph.join(' '));
        if (candidate) {
          summary = candidate;
          break;
        }
        paragraph = [];
      }
      continue;
    }

    if (skipLine(line)) {
      if (paragraph.length > 0) {
        const candidate = stripMarkdownDecorators(paragraph.join(' '));
        if (candidate) {
          summary = candidate;
          break;
        }
        paragraph = [];
      }
      continue;
    }

    paragraph.push(trimmed);
  }

  if (!summary && paragraph.length > 0) {
    summary = stripMarkdownDecorators(paragraph.join(' '));
  }

  if (summary.length > 220) {
    summary = `${summary.slice(0, 217).trimEnd()}...`;
  }

  return { title, summary, role, status, audience };
}

function buildDocsManifest(docsSrc) {
  const markdownFiles = walkMarkdownFiles(docsSrc);
  const items = markdownFiles.map((fullPath) => {
    const relativePath = relative(docsSrc, fullPath).replace(/\\/g, '/');
    const docId = normalizeDocId(relativePath);
    const content = readFileSync(fullPath, 'utf8');
    const meta = extractDocMeta(content, docId);
    const sectionId = classifyDoc(docId);
    const section = getSectionMeta(sectionId);

    return {
      id: docId,
      path: relativePath,
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
      url: `/docs?doc=${encodeURIComponent(docId)}`,
    };
  });

  items.sort((a, b) => {
    if (a.sectionOrder !== b.sectionOrder) return a.sectionOrder - b.sectionOrder;
    if (a.order !== b.order) return a.order - b.order;
    return a.title.localeCompare(b.title);
  });

  const sections = getSectionDefinitions()
    .map((section) => ({
      id: section.id,
      title: section.title,
      description: section.description,
      kind: section.kind,
      order: section.order,
      items: items.filter((item) => item.sectionId === section.id),
    }))
    .filter((section) => section.items.length > 0);

  const liveCount = items.filter((item) => item.kind === 'live').length;
  const archiveCount = items.filter((item) => item.kind === 'archive').length;

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      total: items.length,
      live: liveCount,
      archive: archiveCount,
    },
    featured: FEATURED_DOC_IDS.map((docId) => items.find((item) => item.id === docId)).filter(Boolean),
    readingPaths: READING_PATHS.map((path) => ({
      ...path,
      items: path.items
        .map((docId) => items.find((item) => item.id === docId))
        .filter(Boolean),
    })),
    sections,
    items,
  };
}

function copyDocsAndManifest() {
  const docsSrc = fromFrontend('../docs');
  const docsDest = fromFrontend('static/docs-catalog');
  if (!existsSync(docsSrc)) {
    console.log(`⚠️ Source directory not found: ${docsSrc}`);
    return;
  }

  cleanDir(docsDest);
  cpSync(docsSrc, docsDest, { recursive: true });

  const manifest = buildDocsManifest(docsSrc);
  writeFileSync(join(docsDest, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`✅ Copied docs/ → static/docs-catalog/ (${manifest.counts.total} docs)`);
}

function generateLlmsStaticFiles() {
  const generatorPath = resolve(REPO_ROOT, 'scripts/debug/gpt.cjs');
  if (!existsSync(generatorPath)) {
    throw new Error(`LLMS_CONTEXT_GENERATOR_MISSING:${generatorPath}`);
  }

  execFileSync(process.execPath, [generatorPath], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });

  const llmsPath = fromFrontend('static/llms.txt');
  if (!existsSync(llmsPath) || statSync(llmsPath).size === 0) {
    throw new Error(`LLMS_CONTEXT_GENERATION_FAILED:${llmsPath}`);
  }
}

copyContracts();
copyScenarios();
copyDocsAndManifest();
generateLlmsStaticFiles();

console.log('📦 Static files copied for build');
