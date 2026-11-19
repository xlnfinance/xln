#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { safeParse, safeStringify } from '../../../core/protocol/serialization';
import { readCliOption } from '../../../core/config/cli';
import { candidateRevision, sanitizeDeploymentMessage } from '../deployment/evidence.cjs';
import { prepareIdentities, networks } from './identities';
import { inspectChain } from './chain';
import { prepareCatalog } from './catalog';
import { candidateSources, proposeNativeBudget } from './budget';

const directory = resolve(readCliOption(process.argv.slice(2), '--directory', '.logs/ts-usdc-cross-j-poc/public'));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const identities = prepareIdentities(directory);
const sources = candidateSources();
const chains = [];
try {
  for (const chain of networks) {
    process.stderr.write(`USDC_PREFLIGHT_VERIFY:${chain.chainId}\n`);
    chains.push(await inspectChain(chain, identities));
  }
  const catalogPath = await prepareCatalog(directory, chains);
  if (safeStringify(sources) !== safeStringify(candidateSources())) throw new Error('USDC_PREFLIGHT_CANDIDATE_CHANGED');
  const observation = (name: string): unknown =>
    existsSync(join(directory, name)) ? safeParse(readFileSync(join(directory, name), 'utf8')) : null;
  const funder = chains[0]?.funding.address;
  if (!funder || chains.some(chain => chain.funding.address !== funder))
    throw new Error('USDC_PREFLIGHT_FUNDING_IDENTITY_MISMATCH');
  const report = {
    operation: 'usdc-cross-j-public-preflight',
    status: 'blocked',
    observedAt: new Date().toISOString(),
    candidate: { ...candidateRevision(), sources },
    identities,
    chains,
    catalogPath,
    catalogSha256: createHash('sha256').update(readFileSync(catalogPath)).digest('hex'),
    observations: { operators: observation('operators.json'), transport: observation('transport.json') },
    budget: proposeNativeBudget(identities, funder),
    blockers: [
      'LIVE_EXECUTABLE_QUOTE_AND_TARGET_CREDIT_REQUIRED',
      'FULL_JOURNEY_AND_RECOVERY_GAS_ESTIMATES_INCOMPLETE',
      'USER_AND_OPERATOR_IDENTITIES_UNFUNDED',
      'OWNER_NATIVE_LIMIT_APPROVAL_REQUIRED',
    ],
    currentOperation: { publicFinancialBroadcasts: 0, ethereumTransactionsSigned: 0 },
  };
  writeFileSync(join(directory, 'preflight.json'), safeStringify(report, 2), { mode: 0o600 });
  console.log(safeStringify(report, 2));
  process.exitCode = 2;
} catch (error) {
  let message = error instanceof Error ? error.message : 'USDC_PREFLIGHT_FAILED';
  for (const chain of networks) message = sanitizeDeploymentMessage(message, '', process.env[chain.env]);
  const report = {
    operation: 'usdc-cross-j-public-preflight',
    status: 'failed',
    message,
    observedAt: new Date().toISOString(),
    candidate: { ...candidateRevision(), sources },
    currentOperation: { publicFinancialBroadcasts: 0, ethereumTransactionsSigned: 0 },
  };
  writeFileSync(join(directory, 'preflight.json'), safeStringify(report, 2), { mode: 0o600 });
  console.error(safeStringify(report));
  process.exitCode = 1;
}
