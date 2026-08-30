import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHltLaneJurisdictionsPath } from '../../../scripts/operations/hlt/lanes/lane-runtimes';

test('load-user Runtimes use the current HLT deployment addresses only', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'xln-hlt-jurisdictions-'));
  try {
    const expected = join(workDir, 'prod-mesh', 'jurisdictions.json');
    mkdirSync(join(workDir, 'prod-mesh'), { recursive: true });
    writeFileSync(expected, '{}');
    expect(resolveHltLaneJurisdictionsPath(workDir)).toBe(expected);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('load-user Runtimes reject a missing HLT deployment instead of using repo defaults', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'xln-hlt-jurisdictions-missing-'));
  try {
    expect(() => resolveHltLaneJurisdictionsPath(workDir)).toThrow('HLT_LANE_JURISDICTIONS_MISSING');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
