import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ACCOUNT_TX_TYPES } from '../../../account/tx/catalog';
import { ENTITY_TX_TYPES } from '../../../entity/tx/processing/catalog';
import {
  ACCOUNT_TX_SEMANTIC_CATALOG,
  ENTITY_TX_SEMANTIC_CATALOG,
  TX_SEMANTIC_CATALOG,
  missingSemanticEvidence,
} from './semantic-parity-catalog';

const repositoryRoot = join(import.meta.dir, '../../../..');
const sourceFile = (path: string): string => path.split('#', 1)[0] ?? path;

describe('shared transaction semantic parity catalog', () => {
  test('is exhaustive, unique, and in canonical AccountTx/EntityTx order', () => {
    expect(ACCOUNT_TX_SEMANTIC_CATALOG.map(entry => entry.type)).toEqual(ACCOUNT_TX_TYPES);
    expect(ENTITY_TX_SEMANTIC_CATALOG.map(entry => entry.type)).toEqual(ENTITY_TX_TYPES);

    const keys = TX_SEMANTIC_CATALOG.map(entry => `${entry.layer}:${entry.type}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ACCOUNT_TX_SEMANTIC_CATALOG).toHaveLength(23);
    expect(ENTITY_TX_SEMANTIC_CATALOG).toHaveLength(63);
  });

  test('points only to existing production and semantic-evidence files', () => {
    for (const entry of TX_SEMANTIC_CATALOG) {
      expect(existsSync(join(repositoryRoot, sourceFile(entry.productionPath))), entry.productionPath).toBeTrue();
      if (entry.semanticEvidence === 'covered') {
        expect(entry.evidence.length).toBeGreaterThan(0);
        for (const evidence of entry.evidence) {
          expect(existsSync(join(repositoryRoot, evidence)), evidence).toBeTrue();
        }
      }
    }
  });

  test.skipIf(Bun.env['RSCORE_REQUIRE_SEMANTIC_COMPLETENESS'] !== '1')(
    'has execution evidence for every canonical transaction kind',
    () => {
      const missing = missingSemanticEvidence();
      expect(missing, `SEMANTIC_EVIDENCE_MISSING:\n${missing.join('\n')}`).toEqual([]);
    },
  );
});
