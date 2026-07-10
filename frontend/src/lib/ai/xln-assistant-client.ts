export type XlnAssistantRole = 'system' | 'user' | 'assistant';

export type XlnAssistantMessage = Readonly<{
  role: XlnAssistantRole;
  content: string;
}>;

export type XlnAssistantModel = Readonly<{
  id: string;
  name: string;
}>;

export type XlnAssistantCatalog = Readonly<{
  provider: 'local';
  defaultModel: string;
  models: readonly XlnAssistantModel[];
}>;

type StreamEvent = Readonly<{ content: string; done: boolean }>;

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function parseAssistantSseLine(line: string): StreamEvent {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return { content: '', done: false };
  const data = trimmed.slice(5).trim();
  if (data === '[DONE]') return { content: '', done: true };
  const parsed = parseJsonObject(data);
  return {
    content: typeof parsed?.['content'] === 'string' ? parsed['content'] : '',
    done: false,
  };
}

async function responseError(response: Response): Promise<Error> {
  const text = await response.text();
  const payload = parseJsonObject(text);
  const message = typeof payload?.['message'] === 'string'
    ? payload['message']
    : typeof payload?.['error'] === 'string'
      ? payload['error']
      : `Assistant request failed (${response.status})`;
  return new Error(message);
}

export async function loadXlnAssistantCatalog(signal?: AbortSignal): Promise<XlnAssistantCatalog> {
  const response = await fetch('/api/assistant/models', {
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw await responseError(response);
  const payload = await response.json() as Record<string, unknown>;
  const rawModels = Array.isArray(payload['models']) ? payload['models'] : [];
  const models = rawModels.flatMap((raw): XlnAssistantModel[] => {
    if (!raw || typeof raw !== 'object') return [];
    const record = raw as Record<string, unknown>;
    const id = String(record['id'] ?? '').trim();
    if (!id) return [];
    return [{ id, name: String(record['name'] ?? id).trim() || id }];
  });
  const defaultModel = String(payload['defaultModel'] ?? models[0]?.id ?? '').trim();
  if (!defaultModel || models.length === 0) throw new Error('No local AI model is available.');
  return { provider: 'local', defaultModel, models };
}

export async function streamXlnAssistantReply(input: Readonly<{
  model: string;
  messages: readonly XlnAssistantMessage[];
  onContent: (content: string) => void;
  signal?: AbortSignal;
}>): Promise<string> {
  const response = await fetch('/api/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: input.model, messages: input.messages }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error('Assistant returned an empty stream.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    const lines = buffer.split(/\r?\n/);
    buffer = chunk.done ? '' : lines.pop() ?? '';
    for (const line of lines) {
      const event = parseAssistantSseLine(line);
      if (event.content) {
        answer += event.content;
        input.onContent(event.content);
      }
      if (event.done) done = true;
    }
    if (chunk.done) break;
  }
  if (buffer.trim()) {
    const event = parseAssistantSseLine(buffer);
    if (event.content) {
      answer += event.content;
      input.onContent(event.content);
    }
  }
  if (!answer.trim()) throw new Error('Assistant returned no text.');
  return answer;
}
