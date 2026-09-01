import type { AiMessage } from './ops-ai-decode';
import { aiMessageRoleLabel, formatAiTime } from './ops-ai-model';

function OpsAiMessageView({ message }: Readonly<{ message: AiMessage }>) {
  return <div className={`ops-ai-message ${message.role}`} data-role={message.role}>
    <div className="ops-ai-message-header">
      <span className="ops-ai-role">{aiMessageRoleLabel(message)}</span>
      <span className="ops-ai-time">{formatAiTime(message.timestamp)}</span>
    </div>
    {message.images && message.images.length > 0 ? (
      <div className="ops-ai-message-images">
        {message.images.map((image, index) => (
          <img alt="attached" className="ops-ai-attached-image" key={`${index}-${image.slice(0, 12)}`} src={`data:image/jpeg;base64,${image}`} />
        ))}
      </div>
    ) : null}
    <div className="ops-ai-message-content">{message.content}</div>
    {message.council ? (
      <details className="ops-ai-council-details">
        <summary>View Council Deliberation</summary>
        <div className="ops-ai-council-stages">
          <div className="ops-ai-stage">
            <h4>Stage 1: Individual Responses</h4>
            {Object.entries(message.council.stage1).map(([model, response]) => (
              <details key={model}><summary>{model}</summary><pre>{response}</pre></details>
            ))}
          </div>
          <div className="ops-ai-stage">
            <h4>Stage 2: Peer Reviews</h4>
            {Object.entries(message.council.stage2).map(([model, review]) => (
              <details key={model}><summary>{model}</summary><pre>{review.reasoning}</pre></details>
            ))}
          </div>
        </div>
      </details>
    ) : null}
  </div>;
}

export function OpsAiMessages({ messages, streamingLabel, streamingContent, isLoading }: Readonly<{
  messages: readonly AiMessage[];
  streamingLabel: string;
  streamingContent: string;
  isLoading: boolean;
}>) {
  return <div className="ops-ai-messages" data-testid="ai-messages">
    {messages.map((message, index) => <OpsAiMessageView key={`${index}-${message.timestamp ?? ''}`} message={message} />)}
    {isLoading || streamingContent ? (
      <div className="ops-ai-message assistant" data-testid="ai-thinking">
        <div className="ops-ai-message-header"><span className="ops-ai-role">{streamingLabel}</span></div>
        <div className="ops-ai-message-content">{streamingContent || 'Thinking...'}</div>
      </div>
    ) : null}
    {messages.length === 0 && !isLoading && !streamingContent ? (
      <p className="ops-ai-empty">No messages yet. Ask the local model, or say "hello" once the microphone is live.</p>
    ) : null}
  </div>;
}
