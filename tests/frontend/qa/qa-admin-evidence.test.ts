import { describe, expect, test } from 'bun:test';
import { normalizeQaAdminHealth } from '../../../frontend/src/lib/qa/adminEvidence';

describe('QA admin health projection', () => {
  test('projects runtime, relay and watchtower evidence from the public health boundary', () => {
    const health = normalizeQaAdminHealth({
      systemOk: true,
      coreOk: true,
      system: { runtime: true, relay: false },
      relay: { activeClientCount: 3, profileCount: 7 },
      process: { children: [{ role: 'watchtower', name: 'tower-a', online: true }] },
      storage: { tracked: [] },
      hubMesh: { direct: { openLinkCount: 2 }, pairs: [] },
      disk: { ok: true, freeGiB: 20, usedPct: 30 },
    });

    expect(health).not.toBeNull();
    expect(health?.runtimeOk).toBe(true);
    expect(health?.relayOk).toBe(false);
    expect(health?.relayActiveClientCount).toBe(3);
    expect(health?.relayProfileCount).toBe(7);
    expect(health?.watchtowerCount).toBe(1);
  });
});
