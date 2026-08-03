import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  buildDocsCatalog,
  produceDocsCatalog,
} from '../../frontend/scripts/docs-catalog-producer.ts';

const roots: string[] = [];
const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'xln-docs-generator-'));
  roots.push(root);
  return root;
};
const write = (root: string, path: string, content: string): void => {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
};

afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('docs catalog producer', () => {
  test('produces byte-identical sorted output and content hashes from unchanged inputs', () => {
    const root = temporaryRoot();
    const source = join(root, 'source');
    write(source, 'status.md', '# Status\n\nCurrent source of truth.\n');
    write(source, 'readme.md', '# xln Documentation\n\nCanonical introduction.\n');
    write(source, 'assets/diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
    const first = join(root, 'first');
    const second = join(root, 'second');
    const manifest = produceDocsCatalog(source, first);
    produceDocsCatalog(source, second);
    expect(readFileSync(join(first, 'manifest.json'), 'utf8')).toBe(readFileSync(join(second, 'manifest.json'), 'utf8'));
    expect(manifest.items.map(item => item.id)).toEqual(['readme', 'status']);
    expect(manifest.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.items.every(item => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
  });

  test('fails loudly for missing roots, malformed frontmatter, and normalized duplicates', () => {
    const root = temporaryRoot();
    expect(() => buildDocsCatalog(join(root, 'missing'))).toThrow('DOCS_SOURCE_ROOT_MISSING');
    const malformed = join(root, 'malformed');
    write(malformed, 'readme.md', '---\ntitle xln\n---\n# Readme\n');
    expect(() => buildDocsCatalog(malformed)).toThrow('DOCS_FRONTMATTER_MALFORMED:readme.md:2');
    const duplicate = join(root, 'duplicate');
    write(duplicate, 'readme.md', '# One\n');
    write(duplicate, 'docs/readme.md', '# Two\n');
    expect(() => buildDocsCatalog(duplicate)).toThrow('DOCS_DOCUMENT_ID_DUPLICATE:readme');
  });

  test('rejects symlinks and overlapping source/output roots', () => {
    const root = temporaryRoot();
    const source = join(root, 'source');
    write(source, 'readme.md', '# Readme\n');
    symlinkSync(join(source, 'readme.md'), join(source, 'linked.md'));
    expect(() => buildDocsCatalog(source)).toThrow('DOCS_SOURCE_SYMLINK_REJECTED:linked.md');
    rmSync(join(source, 'linked.md'));
    expect(() => produceDocsCatalog(source, join(source, 'output'))).toThrow('DOCS_ROOTS_OVERLAP');
  });
});
