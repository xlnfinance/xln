// Pure helpers for the React /ai console: streaming parse, chat titles,
// entity-context prompt, URL routing, chat-list ordering, and MLX selection
// rules. No I/O — the source injects fetch/storage, the view injects DOM.

import { compareStableText } from '../../../packages/ui/src/stable-compare';
import {
  AI_DEFAULT_SELECTED_MODEL,
  AI_SPEAK_SLICE,
  type AiEntityContext,
  type AiMessage,
  type AiModel,
  type AiSavedChat,
  type AiToolCall,
  type AiToolDefinition,
} from './ops-ai-decode';

export type AiChatRequest = Readonly<{
  model: string;
  messages: ReadonlyArray<{ role: AiMessage['role']; content: string }>;
  stream: boolean;
  images?: readonly string[];
  tools?: readonly AiToolDefinition[];
  toolChoice?: 'auto';
}>;

/** Same wire format the canonical Svelte page posts to POST /api/chat. */
export const buildAiChatRequest = (request: AiChatRequest): string =>
  JSON.stringify({
    model: request.model,
    messages: request.messages,
    stream: request.stream,
    ...(request.images ? { images: request.images } : {}),
    ...(request.tools ? { tools: request.tools, tool_choice: 'auto' } : {}),
  });

/**
 * Canonical streaming semantics: each decoded chunk is split on newlines and
 * only `data: ` lines are parsed; `data: [DONE]` ends the stream and a line
 * whose JSON is malformed contributes nothing (the Svelte page warned and
 * continued — parse failures are never fatal here).
 */
export const readAiStreamChunk = (chunk: string): string => {
  let content = '';
  for (const line of chunk.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);
    if (data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data) as { content?: unknown };
      if (typeof parsed.content === 'string') content += parsed.content;
    } catch {
      // Malformed partial line between chunk boundaries: skip, as canonical.
    }
  }
  return content;
};

export const resolveAiChatId = (pathname: string): string | null => {
  const match = pathname.match(/^\/ai\/(.+)$/);
  return match?.[1] ?? null;
};

export const generateAiChatTitle = (messages: readonly AiMessage[]): string => {
  const firstUserMessage = messages.find(message => message.role === 'user');
  if (!firstUserMessage) return 'New Chat';
  let title = firstUserMessage.content.slice(0, 35);
  const lastSpace = title.lastIndexOf(' ');
  if (lastSpace > 20) title = title.slice(0, lastSpace);
  return title.trim() || 'New Chat';
};

export const truncateAiChatTitle = (title: string): string =>
  title.length > 25 ? `${title.slice(0, 25)}...` : title;

export const sortAiChatGroups = (
  chats: readonly AiSavedChat[],
): Readonly<{ pinned: readonly AiSavedChat[]; recent: readonly AiSavedChat[] }> => {
  const byUpdatedDesc = (left: AiSavedChat, right: AiSavedChat): number => compareStableText(right.updated, left.updated);
  return {
    pinned: chats.filter(chat => chat.pinned).sort(byUpdatedDesc),
    recent: chats.filter(chat => !chat.pinned).sort(byUpdatedDesc),
  };
};

export const buildAiEntitySystemMessage = (context: AiEntityContext): string => {
  const reservesList = Object.entries(context.reserves)
    .map(([tokenId, amount]) => `  Token ${tokenId}: ${amount}`)
    .join('\n');
  return `You are assisting with xln Entity ${context.entityId}.

Entity Context:
- Entity ID: ${context.entityId}
- Signer ID: ${context.signerId}
- Jurisdiction: ${context.jurisdiction}
- Number of accounts: ${context.accountCount}
- Reserves:
${reservesList || '  (none)'}

Help the user understand this entity's state, suggest actions, or answer questions about xln operations.`;
};

export const nextAiChatId = (now: number, entityId?: string): string =>
  entityId ? `entity-${entityId}-${now}` : `chat-${now}`;

export const isAiMlxModel = (model: AiModel | undefined): boolean =>
  model?.backend?.includes('mlx') === true;

export const aiModelOptionLabel = (model: AiModel, activeModel: string | null): string =>
  `${isAiMlxModel(model) ? (model.id === activeModel ? '[*] ' : '[ ] ') : ''}${model.name || model.id}`;

export const shouldOfferAiMlxLoad = (
  selectedModel: string,
  models: readonly AiModel[],
  activeModel: string | null,
): boolean => {
  const selected = models.find(model => model.id === selectedModel);
  return isAiMlxModel(selected) && selectedModel !== activeModel;
};

export const aiRamBarState = (usedPercent: number): 'ok' | 'warning' | 'danger' =>
  usedPercent > 85 ? 'danger' : usedPercent > 70 ? 'warning' : 'ok';

export const aiAgentStatusMessage = (toolCalls: readonly AiToolCall[]): string =>
  `[Agent] Calling ${toolCalls.length} tool(s): ${toolCalls.map(call => call.function.name).join(', ')}`;

export const aiToolResultMessage = (name: string, result: string): string => `[Tool: ${name}] ${result}`;

export const aiVisionMessage = (description: string): string => `[Vision] ${description}`;

export const aiDefaultSelectedModel = (models: readonly AiModel[], fallback?: string): string => {
  if (fallback && models.some(model => model.id === fallback)) return fallback;
  if (models.some(model => model.id === AI_DEFAULT_SELECTED_MODEL)) return AI_DEFAULT_SELECTED_MODEL;
  return models[0]?.id ?? AI_DEFAULT_SELECTED_MODEL;
};

export const aiSpeakSlice = (content: string): string => content.slice(0, AI_SPEAK_SLICE);

export const formatAiTime = (timestamp: string | undefined): string => {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toLocaleTimeString()}.${date.getMilliseconds().toString().padStart(3, '0')}`;
};

export const aiMessageRoleLabel = (message: AiMessage): string =>
  message.role === 'user' ? 'You' : message.model || 'Assistant';
