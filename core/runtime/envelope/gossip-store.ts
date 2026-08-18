import type { Level } from 'level';
import type { Profile } from '../../entity/profile';
import { canonicalizeProfile, parseProfile } from '../../entity/profile';
import { deserializeTaggedJson, serializeTaggedJson } from '../../protocol/serialization';
import { createStructuredLogger, shortId } from '../../support/logger';
import type { RuntimeReplica } from '../types';

type InfraDbAccess = {
  tryOpenInfraDb: (env: RuntimeReplica) => Promise<boolean>;
  getInfraDb: (env: RuntimeReplica) => Level<Buffer, Buffer>;
};

const INFRA_GOSSIP_INDEX_KEY = 'gossip:index';
const INFRA_GOSSIP_PROFILE_PREFIX = 'gossip:profile:';
const makeInfraGossipProfileKey = (entityId: string): string => `gossip:profile:${String(entityId).toLowerCase()}`;
const infraGossipLog = createStructuredLogger('runtime.envelope_gossip');

const listInfraGossipEntityIds = async (db: Level<Buffer, Buffer>): Promise<string[]> => {
  const ids = new Set<string>();
  for await (const rawKey of db.keys({
    gte: Buffer.from(INFRA_GOSSIP_PROFILE_PREFIX),
    lt: Buffer.from('gossip:profile;'),
  })) {
    const key = rawKey.toString();
    const entityId = key.slice(INFRA_GOSSIP_PROFILE_PREFIX.length).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(entityId)) {
      throw new Error(`INFRA_GOSSIP_PROFILE_KEY_INVALID:${key}`);
    }
    ids.add(entityId);
  }
  return [...ids].sort();
};

const pruneInfraGossipProfile = async (db: Level<Buffer, Buffer>, entityId: string): Promise<void> => {
  const normalizedEntityId = String(entityId || '').toLowerCase();
  if (!normalizedEntityId) return;
  const batch = db.batch();
  batch.del(Buffer.from(makeInfraGossipProfileKey(normalizedEntityId)));
  batch.del(Buffer.from(INFRA_GOSSIP_INDEX_KEY));
  await batch.write();
};

export const persistGossipProfileToInfraDb = async (
  env: RuntimeReplica,
  dbAccess: InfraDbAccess,
  profile: Profile,
): Promise<void> => {
  const dbReady = await dbAccess.tryOpenInfraDb(env);
  if (!dbReady) return;
  const db = dbAccess.getInfraDb(env);
  const canonicalProfile = canonicalizeProfile(profile);
  const entityId = canonicalProfile.entityId.toLowerCase();
  if (!entityId) {
    throw new Error('INFRA_GOSSIP_ENTITY_ID_REQUIRED');
  }
  // Profile keys are the authoritative index. A separate read/modify/write
  // array loses ids when different profile announcements commit concurrently.
  const batch = db.batch();
  batch.put(Buffer.from(makeInfraGossipProfileKey(entityId)), Buffer.from(serializeTaggedJson(canonicalProfile)));
  batch.del(Buffer.from(INFRA_GOSSIP_INDEX_KEY));
  await batch.write();
};

export const loadGossipProfilesFromInfraDb = async (
  env: RuntimeReplica,
  dbAccess: InfraDbAccess,
): Promise<void> => {
  const dbReady = await dbAccess.tryOpenInfraDb(env);
  if (!dbReady) return;
  const db = dbAccess.getInfraDb(env);
  const entityIds = await listInfraGossipEntityIds(db);
  if (entityIds.length === 0) return;
  for (const entityId of entityIds) {
    try {
      const raw = await db.get(Buffer.from(makeInfraGossipProfileKey(entityId)));
      const profile = parseProfile(deserializeTaggedJson(raw.toString()));
      env.gossip.announce(profile);
    } catch (error) {
      infraGossipLog.warn('profile.restore_failed', {
        entityId: shortId(entityId, 8),
        error: error instanceof Error ? error.message : String(error),
      });
      await pruneInfraGossipProfile(db, entityId);
    }
  }
  const migration = db.batch();
  migration.del(Buffer.from(INFRA_GOSSIP_INDEX_KEY));
  await migration.write();
};

export const clearInfraGossipProfiles = async (
  env: RuntimeReplica,
  dbAccess: InfraDbAccess,
  options: { runtimeId?: string } = {},
): Promise<void> => {
  const dbReady = await dbAccess.tryOpenInfraDb(env);
  if (!dbReady) return;
  const db = dbAccess.getInfraDb(env);
  const entityIds = await listInfraGossipEntityIds(db);
  const targetRuntimeId = String(options.runtimeId || '').trim().toLowerCase();
  const batch = db.batch();
  for (const entityId of entityIds) {
    if (targetRuntimeId) {
      const raw = await db.get(Buffer.from(makeInfraGossipProfileKey(entityId)));
      const profile = parseProfile(deserializeTaggedJson(raw.toString()));
      if (String(profile.runtimeId || '').trim().toLowerCase() !== targetRuntimeId) continue;
    }
    batch.del(Buffer.from(makeInfraGossipProfileKey(entityId)));
  }
  batch.del(Buffer.from(INFRA_GOSSIP_INDEX_KEY));
  await batch.write();
};
