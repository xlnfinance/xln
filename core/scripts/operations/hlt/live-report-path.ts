import { join } from 'node:path';

export const hltLiveReportPath = (options: Readonly<{
  workDir: string;
  engine: 'ts' | 'rust';
  workload: string;
}>): string => {
  if (options.engine === 'rust') return join(options.workDir, 'hlt-rust-h1-live.json');
  if (options.workload === 'mixed') return join(options.workDir, 'hlt-ts-h1-live.json');
  if (options.workload === 'payments') return join(options.workDir, 'hlt-payment-load-report.json');
  if (options.workload === 'cross') return join(options.workDir, 'production-cross-swap-load-report.json');
  if (options.workload === 'same') return join(options.workDir, 'production-swap-load-report.json');
  throw new Error(`HLT_LIVE_REPORT_WORKLOAD_INVALID:${options.workload}`);
};
