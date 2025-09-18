import { Level } from 'level';

import {
  getEntityDisplayInfo as getEntityDisplayInfoFromProfileOriginal,
  resolveEntityName as resolveEntityNameOriginal,
  searchEntityNames as searchEntityNamesOriginal,
} from '../name-resolution';

// === NAME RESOLUTION WRAPPERS (override imports) ===
export const searchEntityNames = (db: Level<Buffer, Buffer>, query: string, limit?: number) =>
  searchEntityNamesOriginal(db, query, limit);

export const resolveEntityName = (db: Level<Buffer, Buffer>, entityId: string) =>
  resolveEntityNameOriginal(db, entityId);

export const getEntityDisplayInfoFromProfile = (db: Level<Buffer, Buffer>, entityId: string) =>
  getEntityDisplayInfoFromProfileOriginal(db, entityId);
