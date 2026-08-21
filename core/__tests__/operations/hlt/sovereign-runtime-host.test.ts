import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBytes } from 'ethers';
import { importEntity } from '../../../runtime/registration/entity-creation';
import { acquireLocalTestPortLease } from '../../../scripts/e2e/harness/local-test-port-lease';
import {
  deriveLoadLaneIdentities,
  deriveLoadLaneSeeds,
} from '../../../scripts/operations/hlt/lanes/worker-lanes';
import {
  queueLaneRuntimeInputWave,
  spawnLaneRuntimes,
  stopLaneRuntimes,
} from '../../../scripts/operations/hlt/lanes/lane-runtimes';

const waitForEntity = async (lane: Awaited<ReturnType<typeof spawnLaneRuntimes>>[number]): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await lane.runtime.control.listEntities()).some(entity => entity.entityId === lane.identity.entityId)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`SOVEREIGN_HOST_ENTITY_NOT_COMMITTED:${lane.identity.entityId}`);
};

test('one process hosts isolated sovereign Runtime replicas', async () => {
  const lease = await acquireLocalTestPortLease({ timeoutMs: 10_000 });
  const workDir = mkdtempSync(join(tmpdir(), 'xln-sovereign-host-'));
  const rootSeed = 'sovereign-runtime-host-test-root';
  const seeds = deriveLoadLaneSeeds(rootSeed, 2, 'taker');
  const identities = deriveLoadLaneIdentities(rootSeed, 2, 'taker');
  const lanes = await spawnLaneRuntimes({
    workDir,
    portBase: lease.basePort,
    identities,
    laneSeeds: seeds,
    laneIndexOffset: 0,
  });
  try {
    expect(lanes).toHaveLength(2);
    expect(lanes[0]!.child).toBe(lanes[1]!.child);
    expect(lanes[0]!.hostIngress).toBe(lanes[1]!.hostIngress);
    expect(lanes[0]!.port).not.toBe(lanes[1]!.port);
    expect(lanes[0]!.runtime.adapter.runtimeId).not.toBe(lanes[1]!.runtime.adapter.runtimeId);
    await queueLaneRuntimeInputWave(0, lanes.map(lane => ({
      lane,
      input: {
        runtimeTxs: [importEntity({
          entityId: lane.identity.entityId,
          signerId: lane.identity.signerId,
          entitySeed: getBytes(lane.identity.entitySeed),
          data: {
            config: lane.identity.consensusConfig,
            isProposer: true,
            profileName: lane.identity.name,
            position: lane.identity.position,
          },
        })],
        entityInputs: [],
      },
    })));
    await Promise.all(lanes.map(waitForEntity));
    const entitySets = await Promise.all(lanes.map(lane => lane.runtime.control.listEntities()));
    expect(entitySets[0]!.map(entity => entity.entityId)).toEqual([identities[0]!.entityId]);
    expect(entitySets[1]!.map(entity => entity.entityId)).toEqual([identities[1]!.entityId]);
  } catch (error) {
    for (const lane of lanes) {
      console.error(`sovereign-host stdout:\n${lane.child.stdoutLines.slice(-80).join('\n')}`);
      console.error(`sovereign-host stderr:\n${lane.child.stderrLines.slice(-80).join('\n')}`);
    }
    throw error;
  } finally {
    await stopLaneRuntimes(lanes);
    lease.release();
    rmSync(workDir, { recursive: true, force: true });
  }
}, 60_000);
