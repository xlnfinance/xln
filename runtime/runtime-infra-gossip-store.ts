import type { Level } from 'level';
import type { Profile } from './networking/gossip';
import { canonicalizeProfile, parseProfile } from './networking/gossip';
import { deserializeTaggedJson, serializeTaggedJson } from './serialization-utils';
import type { Env } from './types';

type InfraDbAccess = {
  tryOpenInfraDb: (env: Env) => Promise<boolean>;
  getInfraDb: (env: Env) => Level<Buffer, Buffer>;
};

const INFRA_GOSSIP_INDEX_KEY = 'gossip:index';
const makeInfraGossipProfileKey = (entityId: string): string => `gossip:profile:${String(entityId).toLowerCase()}`;

const readInfraStringArray = async (db: Level<Buffer, Buffer>, key: string): Promise<string[]> => {
  try {
    const raw = await db.get(Buffer.from(key));
    const parsed = deserializeTaggedJson<unknown>(raw.toString());
    return Array.isArray(parsed) ? parsed.map((value) => String(value || '').toLowerCase()).filter(Boolean) : [];
  } catch {
    return [];
  }
};

const pruneInfraGossipProfile = async (db: Level<Buffer, Buffer>, entityId: string): Promise<void> => {
  const normalizedEntityId = String(entityId || '').toLowerCase();
  if (!normalizedEntityId) return;
  const existingIds = await readInfraStringArray(db, INFRA_GOSSIP_INDEX_KEY);
  const nextIds = existingIds.filter((value) => value !== normalizedEntityId);
  const batch = db.batch();
  batch.del(Buffer.from(makeInfraGossipProfileKey(normalizedEntityId)));
  if (nextIds.length > 0) {
    batch.put(Buffer.from(INFRA_GOSSIP_INDEX_KEY), Buffer.from(serializeTaggedJson(nextIds)));
  } else {
    batch.del(Buffer.from(INFRA_GOSSIP_INDEX_KEY));
  }
  await batch.write();
};

export const persistGossipProfileToInfraDb = async (
  env: Env,
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
  const existingIds = await readInfraStringArray(db, INFRA_GOSSIP_INDEX_KEY);
  const nextIds = existingIds.includes(entityId) ? existingIds : [...existingIds, entityId];
  const batch = db.batch();
  batch.put(Buffer.from(makeInfraGossipProfileKey(entityId)), Buffer.from(serializeTaggedJson(canonicalProfile)));
  batch.put(Buffer.from(INFRA_GOSSIP_INDEX_KEY), Buffer.from(serializeTaggedJson(nextIds.sort())));
  await batch.write();
};

export const loadGossipProfilesFromInfraDb = async (
  env: Env,
  dbAccess: InfraDbAccess,
): Promise<void> => {
  const dbReady = await dbAccess.tryOpenInfraDb(env);
  if (!dbReady) return;
  const db = dbAccess.getInfraDb(env);
  const entityIds = await readInfraStringArray(db, INFRA_GOSSIP_INDEX_KEY);
  if (entityIds.length === 0) return;
  for (const entityId of entityIds) {
    try {
      const raw = await db.get(Buffer.from(makeInfraGossipProfileKey(entityId)));
      const profile = parseProfile(deserializeTaggedJson<unknown>(raw.toString()));
      env.gossip.announce(profile);
    } catch (error) {
      console.warn(
        `[infra-db] failed to restore gossip profile ${entityId.slice(-8)}:`,
        error instanceof Error ? error.message : String(error),
      );
      await pruneInfraGossipProfile(db, entityId);
    }
  }
};

export const clearInfraGossipProfiles = async (
  env: Env,
  dbAccess: InfraDbAccess,
): Promise<void> => {
  const dbReady = await dbAccess.tryOpenInfraDb(env);
  if (!dbReady) return;
  const db = dbAccess.getInfraDb(env);
  const entityIds = await readInfraStringArray(db, INFRA_GOSSIP_INDEX_KEY);
  const batch = db.batch();
  for (const entityId of entityIds) {
    batch.del(Buffer.from(makeInfraGossipProfileKey(entityId)));
  }
  batch.del(Buffer.from(INFRA_GOSSIP_INDEX_KEY));
  await batch.write();
};
