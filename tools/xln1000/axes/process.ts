/**
 * P: process weight, P = 50 * (0.7 prose + 0.3 scripts). prose = process-text lines per kernel kLOC, log-scaled
 * 20 (best) .. 200 (worst); scripts = npm script count, linear 40 .. 300. In-tree archives and JSON count, and
 * new root-level markdown or any *plan* / *handoff* markdown is included automatically.
 */
import { gap, linScore, logScore, round, type Axis } from '../model';
import { lineCounts, listTree, readJsonAt, type Repo } from '../repo';

const PROCESS_PATHS = [
  'AGENTS.md',
  'CLAUDE.md',
  'brainvault/AGENTS.md',
  'todo.md',
  'agents',
  '.claude/agents',
  'ai',
  'prompts',
  'audits',
  'docs/owner-profile.md',
  'docs/improvement-loop.md',
  'docs/agent-workflow.md',
  'docs/night-work-plan.md',
  'docs/status.md',
  'docs/roadmap.md',
  'docs/audit-protocol.md',
  'docs/audit',
  'docs/fints.md',
  'docs/fintech-type-safety-protocol.md',
  'docs/mainnet.md',
  'docs/mainnet-acceptance-gate.md',
  'docs/mainnet-engineering-principles.md',
  'docs/launch-design.md',
  'docs/launch-pilot.md',
  'docs/debug.md',
  'docs/e2e-debug-protocol.md',
  'docs/reject-policy.md',
  'docs/stand-ownership.md',
  'docs/wallet-journey-plan.md',
  'docs/ios-native-plan.md',
  'docs/native-wallet-product-plan.md',
  'docs/platform-distribution-plan.md',
  'proofs/readme.md',
  'proofs/gaps.md',
  'proofs/bugs.md',
  'proofs/fixes.md',
];
const TEXT = /\.(md|json|txt|ya?ml)$/;
const NOT_PROCESS_ROOT_DOCS = new Set(['readme.md', 'changelog.md']);

/** Root-level markdown (except readme/changelog) and any *plan* or *handoff* markdown under docs/. */
const automaticPaths = (repo: Repo): string[] =>
  listTree(repo, '.').filter(path => {
    if (!path.endsWith('.md')) return false;
    if (!path.includes('/')) return !NOT_PROCESS_ROOT_DOCS.has(path.toLowerCase());
    return path.startsWith('docs/') && /(plan|handoff)[^/]*\.md$/i.test(path);
  });

export const measureProcess = (repo: Repo, kernelLoc: number): Axis => {
  const paths = [...new Set([...PROCESS_PATHS, ...automaticPaths(repo)])].sort();
  const text = [...lineCounts(repo, paths)].filter(([path]) => TEXT.test(path) && !path.includes('/node_modules/'));
  const processLines = text.reduce((sum, [, lines]) => sum + lines, 0);
  const pkg = readJsonAt<{ scripts: Record<string, string> }>(repo, 'package.json');
  const npmScripts = Object.keys(pkg?.scripts ?? {}).length;
  const perKernelK = processLines / (kernelLoc / 1000);
  const sub = { prose: logScore(perKernelK, 20, 200), scripts: linScore(npmScripts, 40, 300) };
  const score = 50 * (0.7 * sub.prose + 0.3 * sub.scripts);
  const gaps = [
    gap('P', `process prose ${String(round(perKernelK))} lines per kernel kLOC (target 20)`, 35 * (1 - sub.prose)),
    gap('P', `npm scripts ${String(npmScripts)} (target 40)`, 15 * (1 - sub.scripts)),
  ];
  const top = text.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 10);
  const raw = { processLines, processFiles: text.length, perKernelK: round(perKernelK, 1), npmScripts, top };
  return { id: 'P', name: 'Process weight', weight: 50, score, ceiling: score, sub, gaps, vetoes: [], raw };
};
