import { resolve } from 'node:path';

// QA run evidence (per-run artifacts + the history DB) can be pinned outside
// a deploy checkout. Curated screenshots remain tracked inside the checkout.
const QA_EVIDENCE_ROOT = process.env['QA_EVIDENCE_ROOT']
  ? resolve(process.env['QA_EVIDENCE_ROOT'])
  : resolve(process.cwd(), '.logs');

export const QA_LOGS_ROOT = resolve(QA_EVIDENCE_ROOT, 'e2e-parallel');
export const QA_STORY_SCREENSHOTS_ROOT = resolve(process.cwd(), 'tests', 'e2e', 'screenshots');
export const QA_HISTORY_DB_PATH = resolve(QA_EVIDENCE_ROOT, 'qa-history.sqlite');
