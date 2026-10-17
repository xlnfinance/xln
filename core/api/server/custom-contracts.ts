import { compileCustomContract } from '../../runtime/custom-contracts/compiler';
import { simulateCustomContract } from '../../runtime/custom-contracts/simulation';
import { CUSTOM_CONTRACT_TEMPLATES } from '../../runtime/custom-contracts/templates';
import { requireBoundaryRecord } from '../../protocol/boundary-validation';
import { safeStringify } from '../../protocol/serialization';
import { isSameOriginAssistantRequest } from './assistant/policy';
import type { RuntimeReplica } from '../../runtime/types';
import type { ClauseSimulationInput } from '../../runtime/custom-contracts/types';

let compilerBusy = false;
const readBody = async (request: Request): Promise<Record<string, unknown>> => {
  if (!request.body || !request.headers.get('content-type')?.startsWith('application/json')) throw new Error('CLAUSE_JSON_REQUIRED');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  for (;;) {
    const chunk = await reader.read(); if (chunk.done) break;
    length += chunk.value.length;
    if (length > 131072) { await reader.cancel(); throw new Error('CLAUSE_REQUEST_TOO_LARGE'); }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return requireBoundaryRecord(JSON.parse(new TextDecoder().decode(bytes)), 'CLAUSE_REQUEST');
};

const requireDomain = (data: Record<string, unknown>, env: RuntimeReplica | null) => {
  const chainId = Number(data['chainId']); const depositoryAddress = String(data['depositoryAddress']);
  const matches = [...(env?.state.jReplicas.values() ?? [])].filter(j => Number(j.chainId) === chainId &&
    j.contracts?.depository?.toLowerCase() === depositoryAddress.toLowerCase());
  const jurisdiction = matches[0];
  if (matches.length !== 1 || !jurisdiction) throw new Error('CLAUSE_JURISDICTION_NOT_FOUND');
  const rpcUrl = jurisdiction.rpcs?.find(url => /^https?:\/\//.test(url));
  if (!rpcUrl) throw new Error('CLAUSE_RPC_UNAVAILABLE');
  return { chainId, depositoryAddress, rpcUrl };
};
const simulationInput = (row: Record<string, unknown>, env: RuntimeReplica | null): Omit<ClauseSimulationInput, 'artifact'> => {
  const data = requireBoundaryRecord(row['simulation'], 'CLAUSE_SIMULATION');
  const { chainId, depositoryAddress, rpcUrl } = requireDomain(data, env);
  if (!Array.isArray(data['tokenIds']) || !Array.isArray(data['deltas']) || data['tokenIds'].length > 128) throw new Error('CLAUSE_TOKEN_INPUT_INVALID');
  return { chainId, depositoryAddress, rpcUrl, transformerAddress: String(data['transformerAddress']),
    leftEntity: String(data['leftEntity']), rightEntity: String(data['rightEntity']), timestamp: Number(data['timestamp']),
    tokenIds: data['tokenIds'].map(Number), deltas: data['deltas'].map(value => BigInt(String(value))),
    encodedBatch: String(data['encodedBatch']), leftArguments: String(data['leftArguments']), rightArguments: String(data['rightArguments']) };
};

export const handleCustomContractsApi = async (req: Request, path: string, env: RuntimeReplica | null): Promise<Response | null> => {
  if (!path.startsWith('/api/custom-contracts/')) return null;
  const reply = (value: unknown, status = 200) => new Response(safeStringify(value), { status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (path === '/api/custom-contracts/templates' && req.method === 'GET') return reply({ success: true, templates: CUSTOM_CONTRACT_TEMPLATES });
  if (req.method !== 'POST' || !['/api/custom-contracts/compile', '/api/custom-contracts/simulate'].includes(path)) return reply({ error: 'CLAUSE_ROUTE_INVALID' }, 404);
  if (!isSameOriginAssistantRequest(req)) return reply({ error: 'CLAUSE_ORIGIN_REJECTED' }, 403);
  if (compilerBusy) return reply({ error: 'CLAUSE_COMPILER_BUSY' }, 429);
  compilerBusy = true;
  try {
    const body = await readBody(req);
    if (typeof body['source'] !== 'string' || typeof body['contractName'] !== 'string') throw new Error('CLAUSE_SOURCE_REQUIRED');
    const artifact = await compileCustomContract(body['source'], body['contractName']);
    if (path.endsWith('/compile')) return reply({ success: true, artifact });
    const result = await simulateCustomContract({ artifact, ...simulationInput(body, env) });
    return reply({ success: true, ...result, codeHash: artifact.codeHash });
  } catch (error) {
    return reply({ success: false, error: error instanceof Error ? error.message : String(error) }, 400);
  } finally { compilerBusy = false; }
};
