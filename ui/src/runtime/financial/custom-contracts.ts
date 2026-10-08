import { AbiCoder, getCreate2Address, keccak256, randomBytes, hexlify, ZeroHash } from 'ethers';
import type { AccountCustomContract, CustomContractTransition, CustomContractAllowance } from '@xln/core/types/finance/custom-contract';
import type { CompiledClause, ClauseField } from '@xln/core/runtime/custom-contracts/types';
import { encodeClauseFields } from '@xln/core/runtime/custom-contracts/abi';
import { getJson, postJson } from '../http';
import { sendEntityTxs } from '../tx';
import type { AccountDoc } from './manage';

export { encodeClauseFields };
export type ClauseTemplate = { id: string; name: string; contractName: string; description: string; source: string };
export const loadClauseTemplates = async (): Promise<ClauseTemplate[]> => {
  const response = await getJson('/api/custom-contracts/templates', {}, window.location.origin);
  return response['templates'] as ClauseTemplate[];
};
export const compileClause = async (source: string, contractName: string): Promise<CompiledClause> => {
  const response = await postJson('/api/custom-contracts/compile', { source, contractName }, 30_000, window.location.origin);
  return response['artifact'] as CompiledClause;
};
export const verifyClause = async (clause: AccountCustomContract): Promise<CompiledClause> => {
  const artifact = await compileClause(clause.source, clause.contractName);
  if (artifact.initcode !== clause.initcode || artifact.compilerVersion !== clause.compilerVersion ||
    JSON.stringify(artifact.schemas) !== JSON.stringify(clause.schemas)) throw new Error('Signed program does not match the compiled source and argument schemas');
  return artifact;
};
export const submitClauseTransition = (entityId: string, signerId: string, counterpartyEntityId: string, transition: CustomContractTransition) =>
  sendEntityTxs(entityId, signerId, [{ type: 'customContract', data: { counterpartyEntityId, transition } }]);

export const clauseProposal = (artifact: CompiledClause, factory: string, encodedBatch: string, allowances: CustomContractAllowance[]): CustomContractTransition => ({
  kind: 'propose', id: hexlify(randomBytes(32)), program: { source: artifact.source, contractName: artifact.contractName,
    compilerVersion: artifact.compilerVersion, schemas: artifact.schemas, initcode: artifact.initcode,
    transformerAddress: getCreate2Address(factory, ZeroHash, keccak256(artifact.initcode)).toLowerCase(), encodedBatch, allowances },
});

export const decodeClauseValues = (fields: readonly ClauseField[], encoded: string): string[] => {
  if (fields.length === 0) return [];
  const values = AbiCoder.defaultAbiCoder().decode(fields.map(field => field.type), encoded);
  return fields.map((field, index) => `${field.label}: ${String(values[index])}`);
};

export const simulateClause = async (clause: AccountCustomContract, account: AccountDoc, leftArguments: string, rightArguments: string) => {
  const tokens = [...account.state.deltas.entries()].sort(([a], [b]) => a - b);
  const response = await postJson('/api/custom-contracts/simulate', { source: clause.source, contractName: clause.contractName,
    simulation: { ...account.state.domain, transformerAddress: clause.transformerAddress,
      leftEntity: account.state.leftEntity, rightEntity: account.state.rightEntity, timestamp: Math.floor(Date.now() / 1000),
      tokenIds: tokens.map(([id]) => id), deltas: tokens.map(([, delta]) => (delta.ondelta + delta.offdelta).toString()),
      encodedBatch: clause.encodedBatch, leftArguments, rightArguments } }, 30_000, window.location.origin);
  const result = response['deltas'];
  if (!Array.isArray(result) || result.length !== tokens.length) throw new Error('Invalid simulation response');
  const effects = tokens.map(([tokenId, delta], i) => ({ tokenId, amount: BigInt(String(result[i])) - delta.ondelta - delta.offdelta }))
    .filter(effect => effect.amount !== 0n);
  for (const effect of effects) {
    const allowance = clause.allowances.find(row => row.tokenId === effect.tokenId);
    if (!allowance || effect.amount < -allowance.rightAllowance || effect.amount > allowance.leftAllowance) throw new Error('Simulation exceeds the signed spending limits');
  }
  return { effects, gas: String(response['gas']) };
};

/** AI writes Solidity; React renders only the compiled typed argument schemas. */
export const generateClauseSource = async (rules: string, model: string, template: ClauseTemplate): Promise<string> => {
  const response = await fetch('/api/assistant/chat', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ model, messages: [
      { role: 'system', content: 'Return Solidity source only, without markdown. Contract name CustomClause. Preserve the exact applyBatch ABI and schema methods from the template. Constructorless and stateless, only import WideMath.sol. Use Int768/WideMath for arithmetic and tokenIds for token lookup. paramsSchema/leftArgsSchema/rightArgsSchema return JSON arrays of {name,type,label}; these create the React argument form. No JavaScript or frontend code. Parameters are signed; late arguments are untrusted evidence. Explain rules briefly in Solidity comments. Template:\n' + template.source },
      { role: 'user', content: rules },
    ] }) });
  if (!response.ok || !response.body) throw new Error(`AI generation failed (${response.status})`);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = ''; let source = '';
  for (;;) {
    const chunk = await reader.read(); if (chunk.done) break;
    pending += decoder.decode(chunk.value, { stream: true });
    const lines = pending.split('\n'); pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const data = JSON.parse(line.slice(6)) as { error?: { message?: string }; choices?: Array<{ delta?: { content?: string } }> };
      if (data.error) throw new Error(data.error.message || 'AI stream failed');
      source += data.choices?.[0]?.delta?.content ?? '';
    }
  }
  source = source.trim().replace(/^```(?:solidity)?\s*/, '').replace(/\s*```$/, '');
  if (!source.includes('contract CustomClause')) throw new Error('AI did not return the requested CustomClause source');
  return source;
};
