import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseDocsCatalogManifest,
  validateDocsCatalogManifest,
} from '../../frontend/packages/client-core/docs-catalog-contract.js';
import { buildDocsCatalog } from '../../frontend/scripts/docs-catalog-producer.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

const manifest = () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-docs-contract-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'readme.md'), '# xln Documentation\n\nCanonical docs.\n');
  return buildDocsCatalog(root).manifest;
};

describe('docs catalog ingestion contract', () => {
  test('parses a current content-addressed catalog', () => {
    const current = manifest();
    expect(parseDocsCatalogManifest(JSON.stringify(current))).toEqual(current);
    expect(validateDocsCatalogManifest(current)).toEqual([]);
  });

  test('rejects corrupt, partial, unsupported, and internally inconsistent catalogs', () => {
    expect(() => parseDocsCatalogManifest(null)).toThrow('DOCS_CATALOG_NOT_OBJECT');
    expect(() => parseDocsCatalogManifest({ schemaVersion: 1 })).toThrow('DOCS_CATALOG');
    expect(() => parseDocsCatalogManifest({ ...manifest(), schemaVersion: 2 })).toThrow('DOCS_CATALOG_SCHEMA_UNSUPPORTED');
    const current = manifest();
    expect(() => parseDocsCatalogManifest({
      ...current,
      counts: { ...current.counts, total: current.counts.total + 1 },
    })).toThrow('DOCS_CATALOG_COUNT_TOTAL_MISMATCH');
  });

  test('rejects a catalog entry whose path, URL, or hash drifts', () => {
    const current = manifest();
    const entry = current.items[0]!;
    expect(() => parseDocsCatalogManifest({ ...current, items: [{ ...entry, path: '../readme.md' }] }))
      .toThrow('DOCS_CATALOG_ITEM_0_PATH_INVALID');
    expect(() => parseDocsCatalogManifest({ ...current, items: [{ ...entry, url: '/docs?doc=other' }] }))
      .toThrow('DOCS_CATALOG_ITEM_0_URL_INVALID');
    expect(() => parseDocsCatalogManifest({ ...current, items: [{ ...entry, sha256: 'bad' }] }))
      .toThrow('DOCS_CATALOG_ITEM_0_SHA256_INVALID');
  });
});
