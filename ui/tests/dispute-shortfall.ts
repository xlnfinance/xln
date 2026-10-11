import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonRpcProvider } from 'ethers';
import { Depository__factory } from '../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { RemoteRuntimeAdapter } from '../../core/api/runtime-adapter/remote';
import {
  decodeRuntimeManifestEntries,
  decodeEntitySummaries,
  selectLocalHubIdentity,
} from '../../core/scripts/operations/hlt/boundary/worker-boundary';
import { fundFromHub } from './stack';
import { AMOUNT, WAIT, fundCollateral, readState } from './dispute-wallet';

/** A real hub pays credit, then moves its free reserve before the user's exit. */
export async function createUnsecuredClaim(page: Page, hubId: string, provider: JsonRpcProvider): Promise<void> {
  await fundCollateral(page, hubId);
  for (const [amount, total] of [
    ['100', '200000000'],
    ['50', '250000000'],
  ] as const) {
    await fundFromHub(page, amount);
    await expect
      .poll(async () => {
        const state = await readState(page, hubId);
        return [state.ownValue, state.collateral, state.pending, state.mempool];
      }, WAIT)
      .toEqual([total, AMOUNT.toString(), false, 0]);
  }
  const funded = await readState(page, hubId);
  const contract = Depository__factory.connect(funded.depository, provider);
  const reserve = await contract._reserves(hubId, 1);
  expect(reserve).toBeGreaterThan(AMOUNT);

  // privateChain() already restricts this fixture to the stand's leased Anvil.
  // Reuse its operator capability: the hub signs an ordinary R2R + broadcast.
  // No signer impersonation, injected storage, fabricated proof or admin API bypass.
  const root = process.env['XLN_RDB_ROOT'];
  if (!root) throw new Error('P5_PRIVATE_STAND_DIRECTORY_REQUIRED');
  const entries = decodeRuntimeManifestEntries(
    JSON.parse(readFileSync(join(root, 'prod-mesh/runtime-import-manifest.json'), 'utf8')),
  );
  const port = Number(new URL(provider._getConnection().url).port);
  const debtor = new RemoteRuntimeAdapter();
  const receiver = new RemoteRuntimeAdapter();
  try {
    for (const [adapter, label, offset] of [
      [debtor, 'H1', 10],
      [receiver, 'H2', 11],
    ] as const) {
      const entry = entries.find(row => row.label === label);
      if (!entry || entry.engine !== 'ts' || entry.wsUrl !== `ws://127.0.0.1:${port + offset}/rpc`)
        throw new Error(`P5_PRIVATE_TS_HUB_CAPABILITY_MISSING:${label}`);
      await adapter.connect({ mode: 'remote', wsUrl: entry.wsUrl, authKey: entry.token, requestTimeoutMs: 10_000 });
    }
    const source = selectLocalHubIdentity(
      decodeEntitySummaries(await debtor.read<unknown>('entities')),
      debtor.runtimeId,
      31337,
    );
    const recipient = selectLocalHubIdentity(
      decodeEntitySummaries(await receiver.read<unknown>('entities')),
      receiver.runtimeId,
      31337,
    );
    expect(source.entityId).toBe(hubId);
    const recipientBefore = await contract._reserves(recipient.entityId, 1);
    const sequence = debtor.nextCommandSequence;
    if (sequence === null) throw new Error('P5_HUB_COMMAND_FRONTIER_MISSING');
    await debtor.send(
      {
        runtimeTxs: [],
        entityInputs: [
          {
            entityId: hubId,
            signerId: source.signerId,
            entityTxs: [
              { type: 'r2r', data: { toEntityId: recipient.entityId, tokenId: 1, amount: reserve - AMOUNT } },
              { type: 'j_broadcast', data: {} },
            ],
          },
        ],
      },
      { commandId: `p5-reserve-transfer-${sequence}`, commandSequence: sequence },
    );
    await expect.poll(() => contract._reserves(hubId, 1), WAIT).toBe(AMOUNT);
    expect(await contract._reserves(recipient.entityId, 1)).toBe(recipientBefore + reserve - AMOUNT);
  } finally {
    debtor.disconnect();
    receiver.disconnect();
  }
}
