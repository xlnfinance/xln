/**
 * D: public-J reality, D = 40 * (0.4 HEAD bytecode deployed + 0.4 real-time dispute on a public J + 0.2 mainnet).
 * Credit requires a bytecode-hash match on unchanged contracts plus public dispute transaction hashes.
 */
import { gap, weightedSum, type Axis } from '../model';
import { changedSince, commitKnown, lastTouch, readJsonAt, type Repo } from '../repo';

type Jurisdiction = Readonly<{ chainId: number; status: string; rpc: string }>;
type DeployedContract = Readonly<{ name: string; address: string; transactionHash: string; codeHash: string }>;
type ContractsEvidence = Readonly<{
  chainId: number;
  canonicalStackBytecodeVerified?: boolean;
  contracts?: readonly DeployedContract[];
  securedProof?: Readonly<{
    disputeStartTransactionHash?: string;
    disputeFinalizeTransactionHash?: string;
  }>;
}>;
type WatchtowerEvidence = Readonly<{
  chainId: number;
  source?: string;
  verified?: boolean;
  daemonTransactions?: readonly Readonly<{ name: string; hash: string; status: number }>[];
}>;

const COVERED = ['jurisdictions/contracts'];
const CONTRACTS_EVIDENCE_FILE = 'docs/evidence/sepolia-20261011/contracts-and-exit.json';
const WATCHTOWER_EVIDENCE_FILE = 'docs/evidence/sepolia-20261011/offline-watchtower.json';
const WEIGHTS = { headBytecodeOnPublicJ: 0.4, realTimeDisputeOnPublicJ: 0.4, mainnet: 0.2 } as const;
const LOCAL_CHAIN_IDS = new Set([31337, 31338, 1337]);
const HEX_HASH = /^0x[0-9a-fA-F]{64}$/;

const isPublic = (jurisdiction: Jurisdiction): boolean =>
  !LOCAL_CHAIN_IDS.has(jurisdiction.chainId) && !/127\.0\.0\.1|localhost|^\//.test(jurisdiction.rpc);

const hasCurrentSepoliaBytecode = (repo: Repo, publicJurisdictions: ReadonlySet<string>): boolean => {
  if (!publicJurisdictions.has('ethereum-sepolia')) return false;
  const evidence = readJsonAt<ContractsEvidence>(repo, CONTRACTS_EVIDENCE_FILE);
  const binding = lastTouch(repo, CONTRACTS_EVIDENCE_FILE);
  if (!evidence || !binding || changedSince(repo, binding, COVERED)) return false;
  const contracts = evidence.contracts ?? [];
  return (
    evidence.chainId === 11155111 &&
    evidence.canonicalStackBytecodeVerified === true &&
    contracts.length >= 4 &&
    contracts.every(row => HEX_HASH.test(row.codeHash) && HEX_HASH.test(row.transactionHash))
  );
};

const hasCurrentPublicDispute = (repo: Repo, publicJurisdictions: ReadonlySet<string>): boolean => {
  if (!publicJurisdictions.has('ethereum-sepolia')) return false;
  const watchtower = readJsonAt<WatchtowerEvidence>(repo, WATCHTOWER_EVIDENCE_FILE);
  const source = watchtower?.source ?? lastTouch(repo, WATCHTOWER_EVIDENCE_FILE) ?? '';
  if (!watchtower || !commitKnown(repo, source) || changedSince(repo, source, COVERED)) return false;
  const txs = watchtower.daemonTransactions ?? [];
  return (
    watchtower.chainId === 11155111 &&
    watchtower.verified === true &&
    txs.length >= 2 &&
    txs.every(tx => tx.status === 1 && HEX_HASH.test(tx.hash))
  );
};

export const measurePublicJ = (repo: Repo): Axis => {
  const file = readJsonAt<{ jurisdictions: Record<string, Jurisdiction> }>(repo, 'jurisdictions/jurisdictions.json');
  const entries = Object.entries(file?.jurisdictions ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const publicByStatus = (status: string): string[] =>
    entries.filter(([, item]) => isPublic(item) && item.status === status).map(([id]) => id);
  const activeSet = new Set(publicByStatus('active'));
  const configuredPublicSet = new Set([...publicByStatus('active'), ...publicByStatus('pending')]);
  const sub = {
    headBytecodeOnPublicJ: hasCurrentSepoliaBytecode(repo, configuredPublicSet) ? 1 : 0,
    realTimeDisputeOnPublicJ: hasCurrentPublicDispute(repo, configuredPublicSet) ? 1 : 0,
    mainnet: activeSet.has('ethereum') || activeSet.has('ethereum-mainnet') ? 1 : 0,
  };
  const score = 40 * weightedSum(sub, WEIGHTS);
  const gaps = [
    ...(sub.headBytecodeOnPublicJ < 1
      ? [gap('D', 'HEAD bytecode deployed on Sepolia (bytecode hash + tx hashes)', 16)]
      : []),
    ...(sub.realTimeDisputeOnPublicJ < 1
      ? [gap('D', 'real-time dispute on a public J (no clock fast-forward)', 16)]
      : []),
    ...(sub.mainnet < 1 ? [gap('D', 'Ethereum mainnet canary', 8)] : []),
  ];
  const raw = {
    publicActive: publicByStatus('active'),
    publicPending: publicByStatus('pending'),
    contractsEvidenceFile: CONTRACTS_EVIDENCE_FILE,
    watchtowerEvidenceFile: WATCHTOWER_EVIDENCE_FILE,
  };
  return { id: 'D', name: 'Public-J reality', weight: 40, score, ceiling: score, sub, gaps, vetoes: [], raw };
};
