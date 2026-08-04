import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { OPS_ROUTE_CONTRACTS, resolveOpsRoute, validateOpsRouteContracts } from '../../frontend/apps/ops/src/ops-route-capabilities';
import { parseOpsHealth } from '../../frontend/apps/ops/data/ops-health-store';
import { buildReactOpsCandidateManifest } from '../../frontend/packages/build-contracts/react-candidate';
import { createReactViteSurfaceContract } from '../../frontend/packages/build-contracts/vite-surfaces';
import { FRONTEND_ROUTES } from '../../frontend/src/lib/contracts/frontendSurfaces';

const ROOT = resolve(import.meta.dir, '../..');

test('ops routes have one explicit audience, capability set, and data owner', () => {
  expect(validateOpsRouteContracts()).toEqual([]);
  expect(OPS_ROUTE_CONTRACTS.map(route => route.id)).toEqual(['health', 'qa', 'runs', 'scenarios', 'ai', 'embed']);
  expect(resolveOpsRoute('/ai/chat-7').id).toBe('ai');
  expect(resolveOpsRoute('/health').audience).toBe('production-operator');
  expect(() => resolveOpsRoute('/admin')).toThrow('OPS_ROUTE_UNKNOWN:/admin');
});

test('ops artifact remains blocked and excludes edge-owned endpoints', () => {
  const routes = FRONTEND_ROUTES.filter(route => route.surface === 'ops' && route.kind === 'page');
  const manifest = buildReactOpsCandidateManifest(routes);
  expect(manifest.activationBlocked).toBe(true);
  expect(manifest.surface).toBe('ops');
  expect(manifest.entrypoints).toEqual(['ai/index.html', 'embed/index.html', 'health/index.html', 'qa/index.html', 'runs/index.html', 'scenarios/index.html']);
  const patterns = routes.map(route => route.pattern);
  for (const edge of ['/admin', '/radapter', '/rpc', '/rpc2', '/resetdb']) expect(patterns).not.toContain(edge);
});

test('each ops Vite entry mounts only the isolated React root', () => {
  const contract = createReactViteSurfaceContract(resolve(ROOT, 'frontend'), 'ops');
  expect(Object.keys(contract.inputs)).toEqual(['ops-health', 'ops-qa', 'ops-runs', 'ops-scenarios', 'ops-ai', 'ops-embed']);
  for (const input of Object.values(contract.inputs)) { expect(existsSync(input)).toBe(true); expect(readFileSync(input, 'utf8')).toContain('../../src/main.tsx'); }
});

test('health parser represents pre-bootstrap hubs without inventing identity or readiness', () => {
  const health = parseOpsHealth({ timestamp: 10, coreOk: false, systemOk: false, degraded: ['hubs'], system: { runtime: true, relay: true }, source: { dirty: true }, process: { uptimeSec: 4, children: [] }, disk: { ok: true, usedPct: 25, freeBytes: 100 }, storage: { ok: true, tracked: [] }, hubMesh: { ok: false, direct: { openLinkCount: 0 } }, marketMaker: { enabled: false, ok: true }, bootstrapReserves: { ok: false, targetMet: false, entityCount: 0 }, hubs: [{ entityId: '', name: 'H1', online: false, restartCount: 0 }] });
  expect(health.verdict).toBe('FAIL'); expect(health.hubs[0]).toMatchObject({ entityId: 'pending:h1', status: 'down', online: false }); expect(health.uptimeMs).toBe(4000);
});
