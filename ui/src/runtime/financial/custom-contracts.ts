import type { CompiledClause } from '@xln/core/runtime/custom-contracts/types';
import { getJson, postJson } from '../http';

export type ClauseTemplate = { id: string; name: string; contractName: string; description: string; source: string };
export const loadClauseTemplates = async (): Promise<ClauseTemplate[]> => {
  const response = await getJson('/api/custom-contracts/templates', {}, window.location.origin);
  return response['templates'] as ClauseTemplate[];
};
export const compileClause = async (source: string, contractName: string): Promise<CompiledClause> => {
  const response = await postJson('/api/custom-contracts/compile', { source, contractName }, 30_000, window.location.origin);
  return response['artifact'] as CompiledClause;
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
