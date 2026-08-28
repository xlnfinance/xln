import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

import { WALLET_APP_LINKS, resolveWalletAppView } from '../../../frontend/apps/wallet/src/app-shell-model';
import { resolveWalletPage } from '../../../frontend/apps/wallet/src/wallet-model';
import {
  WALLET_FLOW_AUDIT,
  WALLET_FLOW_DEFERRALS,
  WALLET_REQUIREMENT_AUDIT,
} from '../../../frontend/config/wallet-flow-audit';

const expectedRequirements = [
  'boot', 'shell', 'identity', 'onboarding', 'recovery', 'settings', 'diagnostics',
  'assets', 'accounts', 'credit', 'collateral', 'debt', 'solvency', 'disputes', 'history',
  'payments', 'receive', 'invoices', 'moves', 'lending', 'settlement', 'reconnect', 'failures',
  'quotes', 'routing', 'orders', 'orderbook', 'cancel-fill', 'cross-j', 'activity',
].toSorted();

describe('React wallet WP6 flow audit', () => {
  test('maps every implemented flow to a real React route, source, and focused test', () => {
    const linkedViews = new Set(WALLET_APP_LINKS.flatMap(({ view }) => view ? [view] : []));
    for (const flow of WALLET_FLOW_AUDIT) {
      expect(resolveWalletPage(flow.pathname).kind).toBe(flow.page);
      if (flow.view) {
        expect(resolveWalletAppView(flow.search)).toBe(flow.view);
        if (flow.view !== 'overview') expect(linkedViews.has(flow.view)).toBe(true);
      }
      for (const path of [...flow.sources, ...flow.tests]) expect(existsSync(path)).toBe(true);
    }
  });

  test('accounts for every named WP6 requirement without inventing completion', () => {
    expect(WALLET_REQUIREMENT_AUDIT.map(({ id }) => id).toSorted()).toEqual(expectedRequirements);
    expect(new Set(WALLET_REQUIREMENT_AUDIT.map(({ id }) => id)).size).toBe(expectedRequirements.length);
    const flowIds = new Set(WALLET_FLOW_AUDIT.map(({ id }) => id));
    const deferralIds = new Set(WALLET_FLOW_DEFERRALS.map(({ id }) => id));
    for (const requirement of WALLET_REQUIREMENT_AUDIT) {
      expect(requirement.disposition === 'implemented'
        ? flowIds.has(requirement.evidenceId)
        : deferralIds.has(requirement.evidenceId)).toBe(true);
    }
  });

  test('keeps every deferred boundary loud in its owning source', () => {
    for (const deferral of WALLET_FLOW_DEFERRALS) {
      expect(existsSync(deferral.evidenceSource)).toBe(true);
      expect(readFileSync(deferral.evidenceSource, 'utf8')).toContain(deferral.evidenceMarker);
      expect(deferral.reason.length).toBeGreaterThan(20);
    }
    expect(resolveWalletPage('/address').kind).toBe('pending');
  });
});
