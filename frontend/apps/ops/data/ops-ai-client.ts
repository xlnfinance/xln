export const OPS_AI_API_BASE = 'http://localhost:3031';
export type AiModel = Readonly<{ id: string; name: string; vision: boolean; available: boolean; backend: string | null; loaded: boolean }>;
export type AiChatSummary = Readonly<{ id: string; title: string; updated: string }>;
export type AiMessage = Readonly<{ role: 'user' | 'assistant' | 'system'; content: string; model?: string; timestamp?: string }>;
export type AiTool = Readonly<{ name: string; description: string; parameters: unknown }>;
export type AiBootstrap = Readonly<{ models: readonly AiModel[]; councilModels: readonly string[]; defaultModel: string; chats: readonly AiChatSummary[]; tools: readonly AiTool[]; stats: Readonly<{ memoryUsedPct: number | null; gpuUtilPct: number | null; mlxModel: string | null; mlxLoading: boolean }> }>;

const object = (value: unknown, code: string): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code); return value as Record<string, unknown>; };
const string = (value: unknown, code: string): string => { if (typeof value !== 'string' || !value.trim()) throw new Error(code); return value.trim(); };
const optionalString = (value: unknown, code: string): string | null => value === null || value === undefined || value === '' ? null : string(value, code);
const boolean = (value: unknown, code: string): boolean => { if (typeof value !== 'boolean') throw new Error(code); return value; };
const optionalNumber = (value: unknown, code: string): number | null => { if (value === null || value === undefined) return null; if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(code); return value; };
const array = (value: unknown, code: string): readonly unknown[] => { if (!Array.isArray(value)) throw new Error(code); return value; };
const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
  const response = await fetch(`${OPS_AI_API_BASE}${path}`, init); const payload: unknown = await response.json();
  if (!response.ok) { const raw = object(payload, 'OPS_AI_HTTP_BODY_INVALID'); throw new Error(optionalString(raw['error'], 'OPS_AI_HTTP_ERROR_INVALID') ?? `OPS_AI_HTTP_${response.status}`); }
  return payload;
};
const withSignal = (signal?: AbortSignal): RequestInit => signal ? { signal } : {};
const parseMessage = (value: unknown, index: number): AiMessage => {
  const raw = object(value, `OPS_AI_MESSAGE_INVALID:${index}`); const role = string(raw['role'], `OPS_AI_MESSAGE_ROLE_INVALID:${index}`);
  if (role !== 'user' && role !== 'assistant' && role !== 'system') throw new Error(`OPS_AI_MESSAGE_ROLE_UNKNOWN:${role}`);
  const model = optionalString(raw['model'], `OPS_AI_MESSAGE_MODEL_INVALID:${index}`); const timestamp = optionalString(raw['timestamp'], `OPS_AI_MESSAGE_TIME_INVALID:${index}`);
  return Object.freeze({ role, content: string(raw['content'], `OPS_AI_MESSAGE_CONTENT_INVALID:${index}`), ...(model ? { model } : {}), ...(timestamp ? { timestamp } : {}) });
};

export const readAiBootstrap = async (signal?: AbortSignal): Promise<AiBootstrap> => {
  const [modelsValue, chatsValue, toolsValue, statsValue] = await Promise.all([request('/api/models', withSignal(signal)), request('/api/chats', withSignal(signal)), request('/api/xln/tools', withSignal(signal)), request('/api/system/stats', withSignal(signal))]);
  const modelsRaw = object(modelsValue, 'OPS_AI_MODELS_INVALID'); const chatsRaw = object(chatsValue, 'OPS_AI_CHATS_INVALID'); const toolsRaw = object(toolsValue, 'OPS_AI_TOOLS_INVALID'); const statsRaw = object(statsValue, 'OPS_AI_STATS_INVALID');
  const models = array(modelsRaw['models'], 'OPS_AI_MODEL_LIST_INVALID').map((value, index) => { const raw = object(value, `OPS_AI_MODEL_INVALID:${index}`); return Object.freeze({ id: string(raw['id'], `OPS_AI_MODEL_ID_INVALID:${index}`), name: string(raw['name'], `OPS_AI_MODEL_NAME_INVALID:${index}`), vision: boolean(raw['vision'], `OPS_AI_MODEL_VISION_INVALID:${index}`), available: boolean(raw['available'], `OPS_AI_MODEL_AVAILABLE_INVALID:${index}`), backend: optionalString(raw['backend'], `OPS_AI_MODEL_BACKEND_INVALID:${index}`), loaded: raw['loaded'] === undefined ? false : boolean(raw['loaded'], `OPS_AI_MODEL_LOADED_INVALID:${index}`) }); });
  const chats = array(chatsRaw['chats'], 'OPS_AI_CHAT_LIST_INVALID').map((value, index) => { const raw = object(value, `OPS_AI_CHAT_INVALID:${index}`); return Object.freeze({ id: string(raw['id'], `OPS_AI_CHAT_ID_INVALID:${index}`), title: string(raw['title'], `OPS_AI_CHAT_TITLE_INVALID:${index}`), updated: string(raw['updated'] ?? raw['updated_at'], `OPS_AI_CHAT_UPDATED_INVALID:${index}`) }); });
  const tools = array(toolsRaw['tools'], 'OPS_AI_TOOL_LIST_INVALID').map((value, index) => { const raw = object(value, `OPS_AI_TOOL_INVALID:${index}`); const fn = object(raw['function'], `OPS_AI_TOOL_FUNCTION_INVALID:${index}`); return Object.freeze({ name: string(fn['name'], `OPS_AI_TOOL_NAME_INVALID:${index}`), description: optionalString(fn['description'], `OPS_AI_TOOL_DESCRIPTION_INVALID:${index}`) ?? '', parameters: fn['parameters'] ?? {} }); });
  const memory = object(statsRaw['memory'] ?? {}, 'OPS_AI_MEMORY_INVALID'); const gpu = object(statsRaw['gpu'] ?? {}, 'OPS_AI_GPU_INVALID'); const mlx = object(statsRaw['mlx'] ?? {}, 'OPS_AI_MLX_INVALID');
  return Object.freeze({ models: Object.freeze(models), councilModels: Object.freeze(array(modelsRaw['council_models'], 'OPS_AI_COUNCIL_MODELS_INVALID').map((value, index) => string(value, `OPS_AI_COUNCIL_MODEL_INVALID:${index}`))), defaultModel: string(modelsRaw['default_model'], 'OPS_AI_DEFAULT_MODEL_INVALID'), chats: Object.freeze(chats), tools: Object.freeze(tools), stats: Object.freeze({ memoryUsedPct: optionalNumber(memory['usedPercent'], 'OPS_AI_MEMORY_USED_INVALID'), gpuUtilPct: optionalNumber(gpu['utilization'], 'OPS_AI_GPU_UTIL_INVALID'), mlxModel: optionalString(mlx['activeModel'], 'OPS_AI_MLX_MODEL_INVALID'), mlxLoading: mlx['loading'] === undefined ? false : boolean(mlx['loading'], 'OPS_AI_MLX_LOADING_INVALID') }) });
};
export const readAiChat = async (id: string, signal?: AbortSignal): Promise<Readonly<{ id: string; title: string; messages: readonly AiMessage[]; councilMode: boolean }>> => {
  const raw = object(await request(`/api/chats/${encodeURIComponent(id)}`, withSignal(signal)), 'OPS_AI_CHAT_DETAIL_INVALID');
  return Object.freeze({ id: string(raw['id'], 'OPS_AI_CHAT_DETAIL_ID_INVALID'), title: string(raw['title'], 'OPS_AI_CHAT_DETAIL_TITLE_INVALID'), messages: Object.freeze(array(raw['messages'], 'OPS_AI_CHAT_MESSAGES_INVALID').map(parseMessage)), councilMode: raw['council_mode'] === undefined ? false : boolean(raw['council_mode'], 'OPS_AI_CHAT_COUNCIL_INVALID') });
};
export const saveAiChat = async (chat: Readonly<{ id: string; title: string; messages: readonly AiMessage[]; councilMode: boolean }>): Promise<void> => { await request('/api/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: chat.id, title: chat.title, messages: chat.messages, council_mode: chat.councilMode, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }) }); };
export const deleteAiChat = async (id: string): Promise<void> => { await request(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }); };
export const executeAiTool = async (name: string, args: unknown): Promise<unknown> => { const raw = object(await request('/api/xln/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: name, args }) }), 'OPS_AI_TOOL_RESULT_INVALID'); if (raw['error']) throw new Error(string(raw['error'], 'OPS_AI_TOOL_EXECUTION_ERROR_INVALID')); return raw['result']; };
export const loadAiModel = async (model: string): Promise<void> => { const raw = object(await request('/api/models/load', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) }), 'OPS_AI_MODEL_LOAD_INVALID'); if (raw['success'] !== true) throw new Error(optionalString(raw['error'], 'OPS_AI_MODEL_LOAD_ERROR_INVALID') ?? 'OPS_AI_MODEL_LOAD_REJECTED'); };
export const unloadAiModel = async (): Promise<void> => { const raw = object(await request('/api/mlx/unload', { method: 'POST' }), 'OPS_AI_MODEL_UNLOAD_INVALID'); if (raw['success'] !== true) throw new Error(optionalString(raw['error'], 'OPS_AI_MODEL_UNLOAD_ERROR_INVALID') ?? 'OPS_AI_MODEL_UNLOAD_REJECTED'); };
export const requestCouncil = async (query: string, models: readonly string[]): Promise<AiMessage> => { const raw = object(await request('/api/council', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, models }) }), 'OPS_AI_COUNCIL_INVALID'); return Object.freeze({ role: 'assistant', content: string(raw['stage3'], 'OPS_AI_COUNCIL_STAGE3_INVALID'), model: `Council · ${string(raw['chairman'], 'OPS_AI_COUNCIL_CHAIR_INVALID')}`, timestamp: new Date().toISOString() }); };
export const streamAiChat = async (model: string, messages: readonly AiMessage[], signal: AbortSignal, onText: (value: string) => void): Promise<string> => {
  const response = await fetch(`${OPS_AI_API_BASE}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal, body: JSON.stringify({ model, messages: messages.map(({ role, content }) => ({ role, content })), stream: true }) });
  if (!response.ok || !response.body) throw new Error(`OPS_AI_CHAT_HTTP_${response.status}`);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let output = '';
  while (true) { const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done }); const lines = buffer.split('\n'); buffer = lines.pop() ?? ''; for (const line of lines) { if (!line.startsWith('data: ')) continue; const data = line.slice(6); if (data === '[DONE]') continue; const raw = object(JSON.parse(data) as unknown, 'OPS_AI_STREAM_CHUNK_INVALID'); if (raw['content'] !== undefined) { output += string(raw['content'], 'OPS_AI_STREAM_CONTENT_INVALID'); onText(output); } } if (done) break; }
  if (!output.trim()) throw new Error('OPS_AI_STREAM_EMPTY'); return output;
};
