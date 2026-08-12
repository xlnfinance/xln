/**
 * MM mesh scenario — real orchestrator boot (same-j + cross-j books), then
 * optional adversary profile. Does NOT hand-roll hubs/MM.
 *
 *   bun runtime/scenarios/run.ts mm-mesh
 *   bun runtime/scenarios/run.ts mm-mesh --adversary=hub-kill
 *   bun runtime/scenarios/run.ts mm-mesh --adversary=mm-restart
 *
 * Under the hood: local-prod-smoke (dual anvil + orchestrator --mm).
 * Adversary injection is post-bootstrap only (XLN_ADVERSARY_PROFILE).
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

import type { RuntimeReplica } from '../../runtime/types';
import { readCliOption } from '../../config/cli';
import { parseAdversaryProfile } from './mm-mesh-adversary';

const args = globalThis.process.argv.slice(2);

/**
 * Orchestrator entry used by `bun runtime/scenarios/run.ts mm-mesh`.
 * Unused env is the CLI shell Runtime; work happens in local-prod-smoke.
 */
export async function mmMesh(_existingEnv?: RuntimeReplica): Promise<RuntimeReplica> {
  const adversary = parseAdversaryProfile(
    readCliOption(args, '--adversary', process.env['XLN_ADVERSARY_PROFILE'] || 'none'),
  );
  console.log('\n🏛️  MM mesh scenario (orchestrator same-j + cross-j books)\n');
  console.log(`[mm-mesh] adversary=${adversary}`);

  const smokePath = join(process.cwd(), 'runtime/scripts/operations/production/local-prod-smoke.ts');
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn('bun', [smokePath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        XLN_ADVERSARY_PROFILE: adversary,
        // Keep post-bootstrap observation so books are stable before adversary.
        XLN_LOCAL_PROD_SMOKE_POST_BOOTSTRAP_STABILITY_MS:
          process.env['XLN_LOCAL_PROD_SMOKE_POST_BOOTSTRAP_STABILITY_MS'] || '2000',
      },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', code => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`MM_MESH_SMOKE_FAILED exit=${exitCode} adversary=${adversary}`);
  }
  console.log(`\n✅ mm-mesh complete adversary=${adversary}\n`);
  return _existingEnv ?? ({} as RuntimeReplica);
}
