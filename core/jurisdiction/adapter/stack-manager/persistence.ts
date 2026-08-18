/**
 * Atomically adds a verified stack to local jurisdiction discovery.
 * This is operator configuration only: it never selects a jurisdiction for an
 * Entity or mutates Runtime/Entity/Account consensus state. [94/100]
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { resolveJurisdictionsJsonPath } from '../jurisdictions-path';
import { computeJurisdictionsNetworkVersion } from '../kernel/jurisdictions-version';
import {
  clearJurisdictionsCache,
  validateJurisdictionsDataValue,
} from '../kernel/jurisdiction-loader';
import type { DeployJurisdictionStackRequest, JurisdictionStackManifest } from './types';
import { safeStringify } from '../../../protocol/serialization';
import {
  computeJurisdictionGossipHash,
  decodeJurisdictionGossipAnnouncement,
  MAX_JURISDICTION_GOSSIP_RECORDS,
  type JurisdictionGossipAnnouncement,
} from '../../gossip/announcement';

const readRoot = async (path: string): Promise<Record<string, unknown>> => {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return validateJurisdictionsDataValue(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        version: '1',
        lastUpdated: new Date(0).toISOString(),
        jurisdictions: {},
        defaults: { timeout: 30_000, retryAttempts: 3, gasLimit: 1_000_000 },
      };
    }
    throw error;
  }
};

export const assertJurisdictionStackKeyAvailable = async (key: string): Promise<void> => {
  const root = await readRoot(resolveJurisdictionsJsonPath());
  const jurisdictions = root['jurisdictions'];
  if (jurisdictions && typeof jurisdictions === 'object' && !Array.isArray(jurisdictions)) {
    if (Object.hasOwn(jurisdictions, key)) throw new Error(`STACK_MANAGER_JURISDICTION_KEY_EXISTS:${key}`);
  }
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export const acquireStackManagerDeploymentLock = async (): Promise<() => Promise<void>> => {
  const lockPath = `${resolveJurisdictionsJsonPath()}.stack-manager.lock`;
  const ownerPath = `${lockPath}/owner.json`;
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath);
      await writeFile(ownerPath, safeStringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), { mode: 0o600 });
      return async () => { await rm(lockPath, { recursive: true, force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let ownerPid = 0;
      try {
        const owner: unknown = JSON.parse(await readFile(ownerPath, 'utf8'));
        if (owner && typeof owner === 'object' && !Array.isArray(owner)) {
          const pid = (owner as Record<string, unknown>)['pid'];
          if (Number.isSafeInteger(pid) && Number(pid) > 0) ownerPid = Number(pid);
        }
      } catch {
        throw new Error('STACK_MANAGER_DEPLOYMENT_LOCK_INVALID');
      }
      if (ownerPid === 0 || processIsAlive(ownerPid)) throw new Error('STACK_MANAGER_DEPLOYMENT_ACTIVE');
      await rm(lockPath, { recursive: true, force: true });
    }
  }
  throw new Error('STACK_MANAGER_DEPLOYMENT_ACTIVE');
};

export const persistVerifiedJurisdictionStack = async (
  request: DeployJurisdictionStackRequest,
  manifest: JurisdictionStackManifest,
  announcement?: JurisdictionGossipAnnouncement,
  officialFoundationSignerId?: string,
): Promise<{ key: string; name: string }> => {
  const path = resolveJurisdictionsJsonPath();
  const root = await readRoot(path);
  const jurisdictionsValue = root['jurisdictions'];
  if (jurisdictionsValue !== undefined && (
    !jurisdictionsValue || typeof jurisdictionsValue !== 'object' || Array.isArray(jurisdictionsValue)
  )) throw new Error('JURISDICTIONS_MAP_INVALID');
  const jurisdictions = { ...(jurisdictionsValue as Record<string, unknown> | undefined) };
  if (Object.hasOwn(jurisdictions, request.key)) throw new Error(`STACK_MANAGER_JURISDICTION_KEY_EXISTS:${request.key}`);
  jurisdictions[request.key] = {
    name: request.name,
    chainId: manifest.chainId,
    rpc: request.rpcUrl,
    blockTimeMs: request.blockTimeMs,
    explorer: request.explorer,
    currency: request.currency,
    status: 'active',
    ...(request.description ? { description: request.description } : {}),
    primary: Object.keys(jurisdictions).length === 0,
    stackVersion: manifest.stackVersion,
    entityProviderDeploymentBlock: manifest.entityProviderDeploymentBlock,
    deployer: manifest.deployer,
    foundationRecipient: manifest.foundationRecipient,
    contracts: {
      account: manifest.contracts.account,
      hankoVerifier: manifest.contracts.hankoVerifier,
      entityProvider: manifest.contracts.entityProvider,
      depository: manifest.contracts.depository,
      deltaTransformer: manifest.contracts.deltaTransformer,
    },
    tokens: {
      USDT: { symbol: 'USDT', ...manifest.registeredTokens.USDT },
    },
    evmContracts: manifest.evmContracts,
  };
  const version = String(root['version'] || '1');
  const persistedOfficialSigner = typeof root['officialFoundationSignerId'] === 'string'
    ? root['officialFoundationSignerId']
    : undefined;
  if (
    persistedOfficialSigner && officialFoundationSignerId &&
    persistedOfficialSigner !== officialFoundationSignerId
  ) throw new Error('JURISDICTIONS_OFFICIAL_FOUNDATION_SIGNER_CONFLICT');
  const trustedOfficialSigner = officialFoundationSignerId ?? persistedOfficialSigner;
  if (announcement?.scope === 'official' && !trustedOfficialSigner) {
    throw new Error('JURISDICTIONS_OFFICIAL_FOUNDATION_SIGNER_MISSING');
  }
  const next = {
    ...root,
    version,
    lastUpdated: new Date().toISOString(),
    jurisdictions,
    ...(trustedOfficialSigner ? { officialFoundationSignerId: trustedOfficialSigner } : {}),
    ...(announcement ? {
      jurisdictionAnnouncements: (() => {
        const existingRaw = root['jurisdictionAnnouncements'];
        if (existingRaw !== undefined && !Array.isArray(existingRaw)) {
          throw new Error('JURISDICTIONS_GOSSIP_ANNOUNCEMENTS_INVALID');
        }
        const existing = (existingRaw ?? []).map((value) =>
          decodeJurisdictionGossipAnnouncement(value, trustedOfficialSigner),
        );
        const id = computeJurisdictionGossipHash(announcement);
        const records = existing.some((entry) => computeJurisdictionGossipHash(entry) === id)
          ? existing
          : [...existing, announcement];
        if (records.length > MAX_JURISDICTION_GOSSIP_RECORDS) {
          throw new Error('JURISDICTIONS_GOSSIP_ANNOUNCEMENT_CAP_EXCEEDED');
        }
        return records;
      })(),
    } : {}),
  };
  const networkVersion = computeJurisdictionsNetworkVersion(next, version);
  const persisted = { ...next, deployVersion: networkVersion, networkVersion };
  validateJurisdictionsDataValue(persisted);
  const output = safeStringify(persisted, 2);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.stack-manager-${randomUUID()}.tmp`;
  await writeFile(temporary, output, { mode: 0o600 });
  await rename(temporary, path);
  clearJurisdictionsCache();
  return { key: request.key, name: request.name };
};
