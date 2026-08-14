/**
 * Bun CLI for the same Stack Manager orchestration used by the daemon API.
 * Configuration comes from a JSON file and the private key only from the
 * DEPLOYER_PRIVATE_KEY environment variable, never argv or output. [90/100]
 */

import { getBytes } from 'ethers';
import { readFile } from 'node:fs/promises';
import { deployJurisdictionStack } from '../../jurisdiction/adapter/stack-manager/deploy';
import { decodeDeployJurisdictionStackRequest } from '../../jurisdiction/adapter/stack-manager/validation';
import { safeStringify } from '../../protocol/serialization';
import { getConfiguredOfficialFoundationSignerId } from '../../jurisdiction/adapter/core/jurisdiction-loader';

const configFlag = process.argv.indexOf('--config');
const configPath = configFlag >= 0 ? process.argv[configFlag + 1] : undefined;
if (!configPath) throw new Error('STACK_MANAGER_CONFIG_REQUIRED:--config <json>');
const privateKey = String(process.env['DEPLOYER_PRIVATE_KEY'] || '').trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('DEPLOYER_PRIVATE_KEY_REQUIRED');
const request = decodeDeployJurisdictionStackRequest(JSON.parse(await readFile(configPath, 'utf8')));
const officialFoundationSignerId = getConfiguredOfficialFoundationSignerId();
const result = await deployJurisdictionStack(request, {
  signerPrivateKey: getBytes(privateKey),
  ...(officialFoundationSignerId ? { officialFoundationSignerId } : {}),
  onPhase: phase => process.stderr.write(`STACK_MANAGER_PHASE:${phase}\n`),
});
process.stdout.write(`${safeStringify(result, 2)}\n`);
