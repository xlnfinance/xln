/**
 * Bun CLI for the same Stack Manager orchestration used by the daemon API.
 * Configuration comes from a JSON file and the private key only from the
 * DEPLOYER_PRIVATE_KEY environment variable, never argv or output. [90/100]
 */

import { getBytes } from 'ethers';
import { readFile } from 'node:fs/promises';
import { deployJurisdictionStack } from '../../jurisdiction/adapter/stack-manager/deploy';
import { decodeDeployJurisdictionStackRequest, decodeStackDeploymentExecution } from '../../jurisdiction/adapter/stack-manager/validation';
import { safeStringify } from '../../protocol/serialization';
import { getConfiguredOfficialFoundationSignerId } from '../../jurisdiction/adapter/kernel/jurisdiction-loader';

const configFlag = process.argv.indexOf('--config');
const configPath = configFlag >= 0 ? process.argv[configFlag + 1] : undefined;
if (!configPath) throw new Error('STACK_MANAGER_CONFIG_REQUIRED:--config <json>');
const evidenceFlag = process.argv.indexOf('--evidence-dir');
const evidenceDirectory = evidenceFlag >= 0 ? process.argv[evidenceFlag + 1] : undefined;
if (evidenceFlag >= 0 && (!evidenceDirectory || evidenceDirectory.startsWith('--'))) {
  throw new Error('STACK_MANAGER_EVIDENCE_DIRECTORY_REQUIRED:--evidence-dir <directory>');
}
const privateKey = String(process.env['DEPLOYER_PRIVATE_KEY'] || '').trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('DEPLOYER_PRIVATE_KEY_REQUIRED');
const deploymentFlag = process.argv.indexOf('--deployment-id');
const modeFlag = process.argv.indexOf('--mode');
const execution = decodeStackDeploymentExecution({
  deploymentId: deploymentFlag >= 0 ? process.argv[deploymentFlag + 1] : undefined,
  mode: modeFlag >= 0 ? process.argv[modeFlag + 1] : undefined,
});
const request = decodeDeployJurisdictionStackRequest(JSON.parse(await readFile(configPath, 'utf8')));
const officialFoundationSignerId = getConfiguredOfficialFoundationSignerId();
const result = await deployJurisdictionStack(request, {
  ...execution,
  signerPrivateKey: getBytes(privateKey),
  ...(evidenceDirectory ? { evidenceDirectory } : {}),
  ...(officialFoundationSignerId ? { officialFoundationSignerId } : {}),
  onPhase: phase => process.stderr.write(`STACK_MANAGER_PHASE:${phase}\n`),
});
process.stdout.write(`${safeStringify(result, 2)}\n`);
