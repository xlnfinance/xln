#!/usr/bin/env bun

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type BuildInfo = Readonly<{
  solcLongVersion: string;
  input: Record<string, unknown>;
  output: { contracts?: Record<string, Record<string, unknown>> };
}>;

type DeploymentEvidence = Readonly<{
  chainId: number;
  contracts: Record<string, string>;
  evmContracts: Record<string, Readonly<{
    address?: string;
    transactionHash: string;
  }>>;
}>;

const argument = (name: string): string | undefined => {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
};

const deploymentPath = resolve(
  process.cwd(),
  argument('--deployment') || 'jurisdictions/deployments/ethereum-sepolia.json',
);
const buildInfoDirectory = resolve(process.cwd(), 'jurisdictions/artifacts/build-info');
const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8')) as DeploymentEvidence;
if (!Number.isSafeInteger(deployment.chainId) || deployment.chainId <= 0) {
  throw new Error(`VERIFY_CHAIN_ID_INVALID:${String(deployment.chainId)}`);
}

const targets = [
  ['account', 'contracts/Account.sol:Account'],
  ['hankoVerifier', 'contracts/HankoVerifier.sol:HankoVerifier'],
  ['entityProvider', 'contracts/EntityProvider.sol:EntityProvider'],
  ['depository', 'contracts/Depository.sol:Depository'],
  ['deltaTransformer', 'contracts/DeltaTransformer.sol:DeltaTransformer'],
  ['stablecoin', 'contracts/ERC20Mock.sol:ERC20Mock'],
] as const;

const buildInfos = readdirSync(buildInfoDirectory)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(resolve(buildInfoDirectory, name), 'utf8')) as BuildInfo)
  .filter((info) => info.solcLongVersion.startsWith('0.8.36+commit.'));
if (buildInfos.length === 0) throw new Error('VERIFY_SOLC_0836_BUILD_INFO_MISSING');

const buildInfoFor = (identifier: string): BuildInfo => {
  const separator = identifier.lastIndexOf(':');
  const sourceName = identifier.slice(0, separator);
  const contractName = identifier.slice(separator + 1);
  const match = buildInfos.find((info) => Boolean(info.output.contracts?.[sourceName]?.[contractName]));
  if (!match) throw new Error(`VERIFY_BUILD_INFO_MISSING:${identifier}`);
  return match;
};

const postVerification = async (
  address: string,
  identifier: string,
  transactionHash: string,
): Promise<Record<string, unknown>> => {
  const buildInfo = buildInfoFor(identifier);
  const response = await fetch(
    `https://sourcify.dev/server/v2/verify/${deployment.chainId}/${address}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stdJsonInput: buildInfo.input,
        compilerVersion: buildInfo.solcLongVersion,
        contractIdentifier: identifier,
        creationTransactionHash: transactionHash,
      }),
    },
  );
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`VERIFY_SUBMIT_FAILED:${identifier}:${response.status}:${JSON.stringify(body)}`);
  }
  return body;
};

const waitForVerification = async (
  verificationId: string,
  identifier: string,
): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const response = await fetch(`https://sourcify.dev/server/v2/verify/${verificationId}`);
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`VERIFY_STATUS_FAILED:${identifier}:${response.status}:${JSON.stringify(body)}`);
    }
    if (body['isJobCompleted'] === true) {
      const contract = body['contract'] as { match?: unknown } | undefined;
      if (contract?.match === 'exact_match') return body;
      throw new Error(`VERIFY_JOB_INEXACT:${identifier}:${JSON.stringify(body)}`);
    }
    const status = String(body['status'] || body['jobStatus'] || '').toLowerCase();
    if (/success|verified|complete/.test(status)) return body;
    if (/fail|error/.test(status)) {
      throw new Error(`VERIFY_JOB_FAILED:${identifier}:${JSON.stringify(body)}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  throw new Error(`VERIFY_JOB_TIMEOUT:${identifier}:${verificationId}`);
};

const readExistingVerification = async (
  address: string,
): Promise<Record<string, unknown> | null> => {
  const response = await fetch(
    `https://sourcify.dev/server/v2/contract/${deployment.chainId}/${address}`,
  );
  if (response.status === 404) return null;
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`VERIFY_LOOKUP_FAILED:${address}:${response.status}:${JSON.stringify(body)}`);
  }
  return body['match'] === 'exact_match' ? body : null;
};

const results: Array<Record<string, unknown>> = [];
for (const [deploymentKey, identifier] of targets) {
  const contract = deployment.evmContracts[deploymentKey];
  const address = contract?.address || deployment.contracts[deploymentKey];
  if (!contract?.transactionHash || !address) {
    throw new Error(`VERIFY_DEPLOYMENT_EVIDENCE_MISSING:${deploymentKey}`);
  }
  const existing = await readExistingVerification(address);
  const submitted = existing ?? await postVerification(address, identifier, contract.transactionHash);
  const verificationId = String(submitted['verificationId'] || '');
  const completed = existing ?? (
    verificationId ? await waitForVerification(verificationId, identifier) : submitted
  );
  results.push({
    deploymentKey,
    identifier,
    address,
    verificationId: verificationId || null,
    result: completed,
  });
}

console.log(JSON.stringify({
  kind: 'PUBLIC_SOURCE_VERIFICATION',
  chainId: deployment.chainId,
  compiler: buildInfos[0]?.solcLongVersion,
  contracts: results,
}));
