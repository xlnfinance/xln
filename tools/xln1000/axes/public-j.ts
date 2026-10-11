/**
 * D: public-J reality, D = 40 * (0.4 HEAD bytecode deployed + 0.4 real-time dispute on a public J + 0.2 mainnet).
 * Credit requires a bytecode-hash match plus transaction hashes; no collector writes that evidence yet, so every
 * sub-item is 0 and the jurisdiction list below is reported as context only.
 */
import { gap, type Axis } from '../model';
import { readJsonAt, type Repo } from '../repo';

type Jurisdiction = Readonly<{ chainId: number; status: string; rpc: string }>;

const LOCAL_CHAIN_IDS = new Set([31337, 31338, 1337]);
const isPublic = (jurisdiction: Jurisdiction): boolean =>
  !LOCAL_CHAIN_IDS.has(jurisdiction.chainId) && !/127\.0\.0\.1|localhost|^\//.test(jurisdiction.rpc);

export const measurePublicJ = (repo: Repo): Axis => {
  const file = readJsonAt<{ jurisdictions: Record<string, Jurisdiction> }>(repo, 'jurisdictions/jurisdictions.json');
  const entries = Object.entries(file?.jurisdictions ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const publicByStatus = (status: string): string[] =>
    entries.filter(([, item]) => isPublic(item) && item.status === status).map(([id]) => id);
  const sub = { headBytecodeOnPublicJ: 0, realTimeDisputeOnPublicJ: 0, mainnet: 0 };
  const gaps = [
    gap('D', 'HEAD bytecode deployed on Sepolia (bytecode hash + tx hashes)', 16),
    gap('D', 'real-time dispute on a public J (no clock fast-forward)', 16),
    gap('D', 'Ethereum mainnet canary', 8),
  ];
  const raw = { publicActive: publicByStatus('active'), publicPending: publicByStatus('pending'), collector: 'TBD' };
  return { id: 'D', name: 'Public-J reality', weight: 40, score: 0, ceiling: 0, sub, gaps, vetoes: [], raw };
};
