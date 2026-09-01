import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  findArchitectScenarioFrameLine,
  getArchitectErrorMessage,
  getArchitectFrameLabel,
  getArchitectLiveModeBlockMessage,
  getArchitectScenarioScrollTop,
  getNextArchitectEntityName,
  getNextArchitectJurisdictionName,
  listArchitectEntityIds,
} from '../../../frontend/packages/runtime-client/src/architect-panel-view';

describe('Architect panel view model', () => {
  test('normalizes replica keys into stable unique Entity ids', () => {
    expect(listArchitectEntityIds([
      '0xalice:main',
      '0xbob:main',
      '0xalice:secondary',
      'plain-entity',
      ':fallback',
    ])).toEqual(['0xalice', '0xbob', 'plain-entity', ':fallback']);
    expect(listArchitectEntityIds([])).toEqual([]);
  });

  test('finds scenario frame markers case-insensitively and preserves fallback line zero', () => {
    const scenario = [
      '// setup',
      '// Frame 7: payment',
      '// body',
      '// FRAME 12 settlement',
    ].join('\n');

    expect(findArchitectScenarioFrameLine(scenario, 7)).toBe(1);
    expect(findArchitectScenarioFrameLine(scenario, 12)).toBe(3);
    expect(findArchitectScenarioFrameLine(scenario, 99)).toBe(0);
  });

  test('projects deterministic textarea scroll positions and frame labels', () => {
    const scenario = ['// setup', '// FRAME 3:', '// body'].join('\n');
    expect(getArchitectScenarioScrollTop(scenario, 3)).toBe(-32);
    expect(getArchitectScenarioScrollTop(scenario, 3, 20, 10)).toBe(10);
    expect(getArchitectFrameLabel(0)).toBe(0);
    expect(getArchitectFrameLabel(42)).toBe(42);
    expect(getArchitectFrameLabel(-1)).toBe('LIVE');
  });

  test('preserves live-mode and unknown-error text', () => {
    expect(getArchitectLiveModeBlockMessage('mint reserves')).toBe(
      'mint reserves requires LIVE mode. Switch to the current runtime state before acting.',
    );
    expect(getArchitectErrorMessage(new Error('denied'))).toBe('denied');
    expect(getArchitectErrorMessage('unavailable')).toBe('unavailable');
  });

  test('advances jurisdiction and Entity form names without hidden state', () => {
    expect(getNextArchitectJurisdictionName('Testnet1')).toBe('Testnet2');
    expect(getNextArchitectJurisdictionName('testnet09')).toBe('Testnet10');
    expect(getNextArchitectJurisdictionName('Custom')).toBe('Testnet');
    expect(getNextArchitectEntityName('alice')).toBe('bob');
    expect(getNextArchitectEntityName('GRACE')).toBe('heidi');
    expect(getNextArchitectEntityName('heidi')).toBe('entity');
    expect(getNextArchitectEntityName('custom')).toBe('entity');
  });

  test('keeps protocol, Runtime, JAdapter, timer, and panel effects in Svelte', () => {
    const source = readFileSync('frontend/src/lib/view/panels/ArchitectPanel.svelte', 'utf8');
    const shared = readFileSync('frontend/packages/runtime-client/src/architect-panel-view.ts', 'utf8');

    expect(source).toContain("from '../../../../packages/runtime-client/src/architect-panel-view'");
    expect(source).toContain('function openAccountData');
    expect(source).toContain('defaultAccountDisputeConfigForRoleEvidence');
    expect(source).toContain('await submitRuntimeInput');
    expect(source).toContain('debugFundReservesBatch');
    expect(source).toContain('setInterval');
    expect(source).toContain("panelBridge.on('vr:payment'");
    expect(shared).not.toContain('defaultAccountDisputeConfigForRoleEvidence');
    expect(shared).not.toContain('submitRuntimeInput');
    expect(shared).not.toContain("from '@xln/core/jurisdiction/adapter'");
    expect(shared).not.toContain('debugFundReservesBatch(');
    expect(shared).not.toContain('setInterval');
    expect(shared).not.toContain('panelBridge');
  });
});
