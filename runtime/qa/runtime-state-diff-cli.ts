import { readFileSync } from 'fs';

import { safeStringify } from '../protocol/serialization';
import { buildRuntimeStateDiffReportFromJson } from './runtime-state-diff';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const readStateFile = (path: string, side: 'LEFT' | 'RIGHT'): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`RUNTIME_STATE_DIFF_${side}_READ_FAILED: path=${path} ${errorMessage(error)}`, { cause: error });
  }
};

if (import.meta.main) {
  try {
    const paths = process.argv.slice(2);
    if (paths.length !== 2) {
      throw new Error('RUNTIME_STATE_DIFF_USAGE: bun runtime/qa/runtime-state-diff-cli.ts <left.json> <right.json>');
    }
    const report = buildRuntimeStateDiffReportFromJson(
      readStateFile(paths[0]!, 'LEFT'),
      readStateFile(paths[1]!, 'RIGHT'),
    );
    console.log(safeStringify(report, 2));
    process.exitCode = report.equal ? 0 : 1;
  } catch (error) {
    console.error(`RUNTIME_STATE_DIFF_FAILED: ${errorMessage(error)}`);
    process.exitCode = 2;
  }
}
