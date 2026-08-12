import { existsSync, readFileSync } from 'node:fs';

export const readJurisdictionsFile = <T extends object = Record<string, unknown>>(
  filePath: string,
): T | null => {
  if (!existsSync(filePath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root must be a JSON object');
    }
    return parsed as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`JURISDICTIONS_FILE_INVALID:path=${filePath}:error=${message}`, { cause: error });
  }
};
