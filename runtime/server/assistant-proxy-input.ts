export type AssistantMessage = Readonly<{
  role: 'system' | 'user' | 'assistant';
  content: string;
}>;

export type AssistantChatRequest = Readonly<{
  model: string;
  messages: readonly AssistantMessage[];
}>;

export type AssistantModel = Readonly<{ id: string; name: string }>;

const MODEL_PATTERN = /^[a-zA-Z0-9._:/-]{1,160}$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 14;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_TOTAL_CHARS = 42_000;
const MAX_CATALOG_BYTES = 256 * 1024;

export class AssistantInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AssistantInputError';
  }
}

const assertExactKeys = (value: Record<string, unknown>, allowed: readonly string[], code: string): void => {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key));
  if (unexpected) throw new AssistantInputError(code, `Unexpected field: ${unexpected}`);
};

const readLimitedText = async (request: Request): Promise<string> => {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new AssistantInputError('AI_BODY_TOO_LARGE', `Request exceeds ${MAX_BODY_BYTES} bytes.`);
  }
  if (!request.body) throw new AssistantInputError('AI_BODY_REQUIRED', 'Assistant request body is required.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return text + decoder.decode();
    size += chunk.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel('AI_BODY_TOO_LARGE');
      throw new AssistantInputError('AI_BODY_TOO_LARGE', `Request exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
};

const parseMessage = (value: unknown): AssistantMessage => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssistantInputError('AI_MESSAGE_INVALID', 'Assistant message must be an object.');
  }
  const message = value as Record<string, unknown>;
  assertExactKeys(message, ['role', 'content'], 'AI_MESSAGE_FIELD_INVALID');
  const role = message['role'];
  if (role !== 'system' && role !== 'user' && role !== 'assistant') {
    throw new AssistantInputError('AI_MESSAGE_ROLE_INVALID', 'Assistant message role is invalid.');
  }
  if (typeof message['content'] !== 'string') {
    throw new AssistantInputError('AI_MESSAGE_CONTENT_INVALID', 'Assistant message content must be text.');
  }
  const content = message['content'].trim();
  if (!content || content.length > MAX_MESSAGE_CHARS) {
    throw new AssistantInputError(
      'AI_MESSAGE_CONTENT_INVALID',
      `Message must contain 1-${MAX_MESSAGE_CHARS} characters.`,
    );
  }
  return { role, content };
};

export const parseAssistantChatRequest = async (
  request: Request,
  allowedModels: ReadonlySet<string>,
): Promise<AssistantChatRequest> => {
  const contentType = request.headers.get('content-type')?.toLowerCase() || '';
  if (!contentType.startsWith('application/json')) {
    throw new AssistantInputError('AI_CONTENT_TYPE_INVALID', 'Content-Type must be application/json.');
  }
  let value: unknown;
  try {
    value = JSON.parse(await readLimitedText(request));
  } catch (error) {
    if (error instanceof AssistantInputError) throw error;
    throw new AssistantInputError('AI_JSON_INVALID', 'Assistant request is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssistantInputError('AI_REQUEST_INVALID', 'Assistant request must be an object.');
  }
  const body = value as Record<string, unknown>;
  assertExactKeys(body, ['model', 'messages'], 'AI_REQUEST_FIELD_INVALID');
  const model = typeof body['model'] === 'string' ? body['model'].trim() : '';
  if (!MODEL_PATTERN.test(model)) throw new AssistantInputError('AI_MODEL_INVALID', 'Assistant model is invalid.');
  if (!allowedModels.has(model))
    throw new AssistantInputError('AI_MODEL_NOT_ALLOWED', 'Assistant model is not allowed.');
  if (!Array.isArray(body['messages']) || body['messages'].length === 0 || body['messages'].length > MAX_MESSAGES) {
    throw new AssistantInputError('AI_MESSAGES_INVALID', `Assistant requires 1-${MAX_MESSAGES} messages.`);
  }
  const messages = body['messages'].map(parseMessage);
  const totalChars = messages.reduce((total, message) => total + message.content.length, 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    throw new AssistantInputError('AI_CONVERSATION_TOO_LARGE', `Conversation exceeds ${MAX_TOTAL_CHARS} characters.`);
  }
  return { model, messages };
};

export const parseAllowedAssistantModels = (raw: string | undefined): readonly string[] => {
  const values = (raw?.trim() ? raw : 'qwen3-coder:latest,gpt-oss:20b')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (values.length === 0 || values.some(value => !MODEL_PATTERN.test(value))) {
    throw new Error('XLN_ASSISTANT_ALLOWED_MODELS contains an invalid model id');
  }
  return [...new Set(values)];
};

export const sanitizeAssistantCatalog = (
  value: unknown,
  allowedModels: readonly string[],
): readonly AssistantModel[] => {
  const rawModels =
    value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>)['models'])
      ? ((value as Record<string, unknown>)['models'] as unknown[])
      : [];
  const available = new Map<string, AssistantModel>();
  for (const raw of rawModels) {
    if (!raw || typeof raw !== 'object') continue;
    const model = raw as Record<string, unknown>;
    const id = typeof model['id'] === 'string' ? model['id'].trim() : '';
    if (model['available'] === false || !allowedModels.includes(id)) continue;
    const name =
      typeof model['name'] === 'string'
        ? model['name']
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .trim()
            .slice(0, 120)
        : '';
    available.set(id, { id, name: name || id });
  }
  return allowedModels.flatMap(model => (available.has(model) ? [available.get(model)!] : []));
};

export const readAssistantCatalogPayload = async (response: Response): Promise<unknown> => {
  const contentLength = Number(response.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_CATALOG_BYTES) {
    throw new Error('AI_CATALOG_TOO_LARGE');
  }
  if (!response.body) throw new Error('AI_CATALOG_BODY_MISSING');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_CATALOG_BYTES) {
      await reader.cancel('AI_CATALOG_TOO_LARGE');
      throw new Error('AI_CATALOG_TOO_LARGE');
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text);
};
