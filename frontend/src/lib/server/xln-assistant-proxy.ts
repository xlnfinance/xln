import type { XlnAssistantMessage } from '$lib/ai/xln-assistant-client';

export type XlnAssistantProxyRequest = Readonly<{
  model: string;
  messages: readonly XlnAssistantMessage[];
}>;

const MODEL_PATTERN = /^[a-zA-Z0-9._:/-]{1,160}$/;
const MAX_MESSAGES = 14;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_TOTAL_CHARS = 42_000;

export function xlnAssistantUpstreamUrl(): string {
  return String(process.env['XLN_AI_SERVER_URL'] || 'http://127.0.0.1:3031').replace(/\/+$/, '');
}

export function parseXlnAssistantProxyRequest(value: unknown): XlnAssistantProxyRequest {
  if (!value || typeof value !== 'object') throw new Error('Assistant request must be an object.');
  const record = value as Record<string, unknown>;
  const model = String(record['model'] ?? '').trim();
  if (!MODEL_PATTERN.test(model)) throw new Error('Assistant model is invalid.');
  if (!Array.isArray(record['messages']) || record['messages'].length === 0 || record['messages'].length > MAX_MESSAGES) {
    throw new Error(`Assistant requires 1-${MAX_MESSAGES} messages.`);
  }
  let totalChars = 0;
  const messages = record['messages'].map((raw): XlnAssistantMessage => {
    if (!raw || typeof raw !== 'object') throw new Error('Assistant message is invalid.');
    const message = raw as Record<string, unknown>;
    const role = message['role'];
    if (role !== 'system' && role !== 'user' && role !== 'assistant') throw new Error('Assistant role is invalid.');
    const content = String(message['content'] ?? '').trim();
    if (!content || content.length > MAX_MESSAGE_CHARS) throw new Error(`Assistant message exceeds ${MAX_MESSAGE_CHARS} characters.`);
    totalChars += content.length;
    return { role, content };
  });
  if (totalChars > MAX_TOTAL_CHARS) throw new Error(`Assistant conversation exceeds ${MAX_TOTAL_CHARS} characters.`);
  return { model, messages };
}

export function sanitizeXlnAssistantCatalog(value: unknown): Readonly<{
  provider: 'local';
  defaultModel: string;
  models: readonly Readonly<{ id: string; name: string }>[];
}> {
  if (!value || typeof value !== 'object') throw new Error('Local AI returned an invalid model catalog.');
  const record = value as Record<string, unknown>;
  const rawModels = Array.isArray(record['models']) ? record['models'] : [];
  const models = rawModels.flatMap((raw): Array<{ id: string; name: string }> => {
    if (!raw || typeof raw !== 'object') return [];
    const model = raw as Record<string, unknown>;
    if (model['available'] === false) return [];
    const id = String(model['id'] ?? '').trim();
    if (!MODEL_PATTERN.test(id)) return [];
    return [{ id, name: String(model['name'] ?? id).trim() || id }];
  });
  const requestedDefault = String(record['default_model'] ?? '').trim();
  const defaultModel = models.some(model => model.id === requestedDefault) ? requestedDefault : models[0]?.id ?? '';
  if (!defaultModel) throw new Error('No local AI model is available.');
  return { provider: 'local', defaultModel, models };
}

export function assistantOfflineResponse(): Response {
  return Response.json({
    code: 'AI_OFFLINE',
    message: 'Local AI is offline. Start the xln AI service and retry.',
  }, { status: 503 });
}
