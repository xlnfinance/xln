import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  loadXlnAssistantCatalog,
  streamXlnAssistantReply,
  type XlnAssistantCatalog,
  type XlnAssistantMessage,
} from '@xln/frontend/lib/ai/xln-assistant-client';
import { buildXlnGuideMessages, suggestedXlnGuideQuestions } from '@xln/frontend/lib/ai/xln-guide-context';
import { renderSafeMarkdown } from '@xln/frontend/lib/security/safe-markdown';
import type { MascotPresence } from '@xln/frontend/lib/components/XlnMascot/mascot-types';

type Props = {
  pathname: string;
  messages: XlnAssistantMessage[];
  setMessages: Dispatch<SetStateAction<XlnAssistantMessage[]>>;
  onClose: () => void;
  onPresence: (state: MascotPresence) => void;
};

export function GuideChat({ pathname, messages, setMessages, onClose, onPresence }: Props) {
  const [catalog, setCatalog] = useState<XlnAssistantCatalog | null>(null);
  const [model, setModel] = useState('');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);
  const [sending, setSending] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const activeResponseIndex = useRef<number | null>(null);
  const inputElement = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);

  const connect = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setChecking(true);
    setError('');
    onPresence('idle');
    try {
      const next = await loadXlnAssistantCatalog(request.signal);
      if (controller.current !== request) return null;
      setCatalog(next);
      setModel(next.defaultModel);
      onPresence('ready');
      return next;
    } catch (reason) {
      if (request.signal.aborted || controller.current !== request) return null;
      setCatalog(null);
      setError(reason instanceof Error ? reason.message : 'Local AI is offline.');
      onPresence('offline');
      return null;
    } finally {
      if (controller.current === request) {
        controller.current = null;
        setChecking(false);
      }
    }
  }, [onPresence]);

  useEffect(() => {
    void connect();
    const frame = requestAnimationFrame(() => inputElement.current?.focus());
    return () => {
      const index = activeResponseIndex.current;
      if (index !== null)
        setMessages(previous => previous.filter((message, position) => position !== index || message.content.trim()));
      activeResponseIndex.current = null;
      controller.current?.abort();
      controller.current = null;
      cancelAnimationFrame(frame);
    };
  }, [connect, setMessages]);

  useEffect(() => {
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function submit(questionInput = input) {
    const question = questionInput.trim();
    if (!question || sending || checking || controller.current) return;
    const available = catalog ?? (await connect());
    if (!available) return;
    const selected = catalog ? model : available.defaultModel;
    const request = new AbortController();
    controller.current = request;
    const responseIndex = messages.length + 1;
    activeResponseIndex.current = responseIndex;
    setInput('');
    setError('');
    setSending(true);
    onPresence('thinking');
    setMessages(previous => [...previous, { role: 'user', content: question }, { role: 'assistant', content: '' }]);
    try {
      const context = await buildXlnGuideMessages({
        query: question,
        pathname,
        history: messages.slice(-10),
        signal: request.signal,
      });
      await streamXlnAssistantReply({
        model: selected,
        messages: context,
        signal: request.signal,
        onContent: content => {
          if (controller.current !== request) return;
          setMessages(previous =>
            previous.map((message, index) =>
              index === responseIndex ? { ...message, content: message.content + content } : message,
            ),
          );
        },
      });
      if (controller.current === request) onPresence('ready');
    } catch (reason) {
      if (request.signal.aborted || controller.current !== request) return;
      setMessages(previous => previous.filter((message, index) => index !== responseIndex || message.content.trim()));
      const message = reason instanceof Error ? reason.message : 'The assistant request failed.';
      setError(message);
      onPresence('idle');
    } finally {
      if (controller.current === request) {
        controller.current = null;
        activeResponseIndex.current = null;
        setSending(false);
      }
    }
  }

  return (
    <section
      className="guide-chat"
      data-testid="xln-mascot-chat"
      aria-label="xln assistant"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header>
        <div>
          <strong>Ask xln</strong>
          <small>{checking ? 'Connecting…' : catalog ? 'Local AI · public docs' : 'Local AI offline'}</small>
        </div>
        <div className="guide-header-actions">
          <button
            type="button"
            className="btn sm"
            aria-label="Retry local AI"
            disabled={sending || checking}
            onClick={() => void connect()}
          >
            Retry
          </button>
          <button
            type="button"
            className="btn sm"
            data-testid="xln-mascot-close"
            aria-label="Close xln assistant"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </header>
      {catalog && catalog.models.length > 1 && (
        <label className="guide-model">
          Model
          <select
            aria-label="Local AI model"
            value={model}
            disabled={sending}
            onChange={event => setModel(event.target.value)}
          >
            {catalog.models.map(entry => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="guide-transcript" ref={transcript} aria-live="polite">
        {messages.length === 0 ? (
          <>
            <div className="guide-intro">
              <strong>Point at the confusing part.</strong>
              <p>I’ll explain this screen using xln’s own documentation.</p>
            </div>
            <div className="guide-suggestions" aria-label="Suggested questions">
              {suggestedXlnGuideQuestions(pathname).map(question => (
                <button
                  key={question}
                  type="button"
                  disabled={sending || checking}
                  onClick={() => void submit(question)}
                >
                  {question}
                </button>
              ))}
            </div>
          </>
        ) : (
          messages.map((message, index) => (
            <article key={index} className={message.role}>
              <span>{message.role === 'assistant' ? 'xln' : 'You'}</span>
              <div
                className="guide-markdown"
                dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(message.content || 'Thinking…') }}
              />
            </article>
          ))
        )}
      </div>
      {error && (
        <div className="guide-error" role="status">
          {error} <a href="/ai">Open AI setup</a>
        </div>
      )}
      <form
        onSubmit={event => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="xln-mascot-question">Ask about this screen</label>
        <div className="guide-composer">
          <textarea
            ref={inputElement}
            id="xln-mascot-question"
            data-testid="xln-mascot-input"
            value={input}
            onChange={event => setInput(event.target.value)}
            rows={1}
            maxLength={2000}
            placeholder="Why does this account need collateral?"
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <button
            type="submit"
            className="btn primary sm"
            data-testid="xln-mascot-submit"
            aria-label="Send question"
            disabled={!input.trim() || sending || checking}
          >
            Send
          </button>
        </div>
        <small>Local AI · public documentation. No wallet keys, signatures or private runtime state.</small>
      </form>
    </section>
  );
}
