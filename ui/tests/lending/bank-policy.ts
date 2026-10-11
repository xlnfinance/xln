import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RemoteRuntimeAdapter } from '../../../core/api/runtime-adapter/remote';
import { decodeRuntimeManifestEntries } from '../../../core/scripts/operations/hlt/boundary/worker-boundary';
import type { AggregatedHealth } from '../../../core/orchestrator/orchestrator-types';
import type { StorageAccountDoc } from '../../../core/storage/types';
import type { RuntimeAdapterViewFrame } from '../../../core/api/public/runtime-module';
import type { EntityTx } from '../../../core/types/entity-tx';
import type { LendingTermId } from '../../../core/types/finance/lending';
import type { Parties } from './financial-evidence';

export async function readBankOwnerConnection(page: Page, hubId: string) {
  const root = process.env['XLN_RDB_ROOT'];
  if (!root) throw new Error('BANK_POLICY_STAND_REQUIRED');
  const response = await page.request.get('/api/health');
  expect(response.ok()).toBe(true);
  const health: AggregatedHealth = await response.json();
  const hub = health.hubs?.find(value => value.entityId === hubId);
  if (!hub?.runtimeId) throw new Error('BANK_POLICY_HUB_MISSING');
  const entries = decodeRuntimeManifestEntries(JSON.parse(readFileSync(join(root, 'prod-mesh/runtime-import-manifest.json'), 'utf8')));
  const entry = entries.find(value => value.label === hub.name);
  if (!entry) throw new Error('BANK_POLICY_OWNER_BINDING_MISSING');
  return { hub, entry };
}

/** Real bank governance through the stand's authenticated owner command lane. */
export async function setBankPolicy(page: Page, ids: Parties, options: {
  termId: LendingTermId; savingsInterestBps: number; loanInterestBps: number; maxPrincipal?: bigint; loanLateMs?: number;
}) {
  const { hub, entry } = await readBankOwnerConnection(page, ids.hubId);
  const adapter = new RemoteRuntimeAdapter();
  await adapter.connect({ mode: 'remote', wsUrl: entry.wsUrl, authKey: entry.token, runtimeId: hub.runtimeId });
  try {
    await expect.poll(() => adapter.commandReady).toBe(true);
    const core = await adapter.read<NonNullable<RuntimeAdapterViewFrame['activeEntity']>['core']>(`/entity/${ids.hubId}`);
    if (!core.signerId) throw new Error('BANK_POLICY_SIGNER_MISSING');
    const account = await adapter.read<StorageAccountDoc>(`/entity/${ids.hubId}/account/${ids.ownerId}`);
    const { termId, savingsInterestBps, loanInterestBps } = options;
    const terms = { ...account.state.domain, tokenId: ids.tokenId, termId, savingsInterestBps, loanInterestBps, loanLateMs: options.loanLateMs ?? 0, expiresAt: core.timestamp + 86_400_000 };
    const txs: EntityTx[] = [{ type: 'lendingSetTerms', data: terms }];
    if (options.maxPrincipal !== undefined) txs.push({ type: 'lendingApprove', data: {
      borrowerEntityId: ids.ownerId, tokenId: ids.tokenId, termId,
      maxPrincipal: options.maxPrincipal, expiresAt: terms.expiresAt,
    } });
    await adapter.send({ runtimeTxs: [], entityInputs: [{ entityId: ids.hubId, signerId: core.signerId, entityTxs: txs }] }, {
      commandId: `bank-policy-${crypto.randomUUID()}`, commandSequence: adapter.nextCommandSequence!,
    });
    const policy = async () => {
      const result = await page.request.get('/api/lending/state', { params: { hubEntityId: ids.hubId, userEntityId: ids.ownerId, tokenId: String(ids.tokenId) } });
      expect(result.ok()).toBe(true);
      return result.json();
    };
    await expect.poll(async () => (await policy()).terms).toContainEqual(terms);
    if (options.maxPrincipal !== undefined) await expect.poll(async () => {
      return (await policy()).facilities;
    }).toContainEqual({ ...account.state.domain, borrowerEntityId: ids.ownerId, tokenId: ids.tokenId, termId,
      maxPrincipal: options.maxPrincipal.toString(), expiresAt: terms.expiresAt, jNonce: account.state.jNonce });
  } finally { await adapter.disconnect(); }
}
