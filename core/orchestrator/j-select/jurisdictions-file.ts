import { existsSync, readFileSync } from 'node:fs';
import { requireBoundaryRecord } from '../../protocol/boundary-validation';

/** Raw disk boundary only: callers must apply their product-specific decoder. */
export const readJurisdictionsFile = (
  filePath: string,
): Record<string, unknown> | null => {
  if (!existsSync(filePath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    return requireBoundaryRecord(parsed, 'root must be a JSON object');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`JURISDICTIONS_FILE_INVALID:path=${filePath}:error=${message}`, { cause: error });
  }
};
