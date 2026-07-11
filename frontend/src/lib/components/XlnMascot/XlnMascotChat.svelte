<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { ArrowUp, ExternalLink, RotateCw, X } from 'lucide-svelte';
  import './xln-mascot-chat.css';
  import {
    loadXlnAssistantCatalog,
    streamXlnAssistantReply,
    type XlnAssistantCatalog,
    type XlnAssistantMessage,
  } from '$lib/ai/xln-assistant-client';
  import { buildXlnGuideMessages, suggestedXlnGuideQuestions } from '$lib/ai/xln-guide-context';
  import { renderSafeMarkdown } from '$lib/security/safe-markdown';

  export let pathname = '/app';
  export let messages: XlnAssistantMessage[] = [];
  export let onClose: () => void = () => {};
  export let onPresence: (presence: 'idle' | 'ready' | 'offline' | 'thinking') => void = () => {};

  let catalog: XlnAssistantCatalog | null = null;
  let selectedModel = '';
  let input = '';
  let error = '';
  let checking = true;
  let sending = false;
  let inputElement: HTMLTextAreaElement;
  let transcriptElement: HTMLDivElement;
  let requestController: AbortController | null = null;
  let scrollFrame = 0;

  $: suggestions = suggestedXlnGuideQuestions(pathname);

  function scheduleScroll(): void {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      transcriptElement?.scrollTo({ top: transcriptElement.scrollHeight, behavior: 'smooth' });
    });
  }

  async function connect(): Promise<void> {
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    checking = true;
    error = '';
    onPresence('idle');
    try {
      const nextCatalog = await loadXlnAssistantCatalog(controller.signal);
      if (requestController !== controller) return;
      catalog = nextCatalog;
      selectedModel = nextCatalog.defaultModel;
      onPresence('ready');
    } catch (reason) {
      if (requestController !== controller || (reason instanceof DOMException && reason.name === 'AbortError')) return;
      catalog = null;
      error = reason instanceof Error ? reason.message : 'Local AI is offline.';
      onPresence('offline');
    } finally {
      if (requestController === controller) {
        requestController = null;
        checking = false;
      }
    }
  }

  async function submit(questionInput = input): Promise<void> {
    const question = questionInput.trim();
    if (!question || sending) return;
    if (!catalog || !selectedModel) {
      await connect();
      if (!catalog || !selectedModel) return;
    }
    const history = messages.slice(-10);
    messages = [...messages, { role: 'user', content: question }, { role: 'assistant', content: '' }];
    input = '';
    error = '';
    sending = true;
    onPresence('thinking');
    scheduleScroll();
    const controller = new AbortController();
    requestController = controller;
    try {
      const requestMessages = await buildXlnGuideMessages({
        query: question,
        pathname,
        history,
        signal: controller.signal,
      });
      await streamXlnAssistantReply({
        model: selectedModel,
        messages: requestMessages,
        signal: controller.signal,
        onContent: (content) => {
          const lastIndex = messages.length - 1;
          messages = messages.map((message, index) => index === lastIndex
            ? { ...message, content: message.content + content }
            : message);
          scheduleScroll();
        },
      });
      onPresence('ready');
    } catch (reason) {
      messages = messages.filter((message, index) => index !== messages.length - 1 || message.content.trim());
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      error = reason instanceof Error ? reason.message : 'The assistant request failed.';
      onPresence(error.toLocaleLowerCase().includes('offline') ? 'offline' : 'ready');
    } finally {
      if (requestController === controller) requestController = null;
      sending = false;
      await tick();
      scheduleScroll();
    }
  }

  function handleInputKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  onMount(() => {
    void connect();
    requestAnimationFrame(() => inputElement?.focus());
  });

  onDestroy(() => {
    requestController?.abort();
    cancelAnimationFrame(scrollFrame);
  });
</script>

<section class="assistant-panel" data-testid="xln-mascot-chat" aria-label="xln assistant">
  <header>
    <div class="identity">
      <span class="mini-mark" aria-hidden="true"></span>
      <span><strong>Ask xln</strong><small>{checking ? 'Connecting…' : catalog ? 'Local AI · public docs' : 'Local AI offline'}</small></span>
    </div>
    <div class="header-actions">
      <button type="button" aria-label="Retry local AI" title="Retry" on:click={() => void connect()}><RotateCw size={15} /></button>
      <button type="button" data-testid="xln-mascot-close" aria-label="Close xln assistant" on:click={onClose}><X size={16} /></button>
    </div>
  </header>

  {#if catalog && catalog.models.length > 1}
    <label class="model-row">
      <span>Model</span>
      <select bind:value={selectedModel} aria-label="Local AI model">
        {#each catalog.models as model}
          <option value={model.id}>{model.name}</option>
        {/each}
      </select>
    </label>
  {/if}

  <div class="transcript" bind:this={transcriptElement} aria-live="polite">
    {#if messages.length === 0}
      <div class="intro">
        <strong>Point at the confusing part.</strong>
        <p>I’ll explain this screen using xln’s own documentation.</p>
      </div>
      <div class="suggestions" aria-label="Suggested questions">
        {#each suggestions as suggestion}
          <button type="button" on:click={() => void submit(suggestion)}>{suggestion}</button>
        {/each}
      </div>
    {:else}
      {#each messages as message}
        <article class:assistant={message.role === 'assistant'} class:user={message.role === 'user'}>
          <span>{message.role === 'assistant' ? 'xln' : 'You'}</span>
          <div class="message-markdown">{@html renderSafeMarkdown(message.content || 'Thinking…')}</div>
        </article>
      {/each}
    {/if}
  </div>

  {#if error}
    <div class="assistant-error" role="status">
      <span>{error}</span>
      <a href="/ai">Open AI setup <ExternalLink size={12} /></a>
    </div>
  {/if}

  <form on:submit={(event) => { event.preventDefault(); void submit(); }}>
    <label for="xln-mascot-question">Ask about this screen</label>
    <div class="composer">
      <textarea
        id="xln-mascot-question"
        data-testid="xln-mascot-input"
        bind:this={inputElement}
        bind:value={input}
        rows="1"
        maxlength="2000"
        placeholder="Why does this account need collateral?"
        on:keydown={handleInputKeydown}
      ></textarea>
      <button
        type="submit"
        data-testid="xln-mascot-submit"
        aria-label="Send question"
        disabled={!input.trim() || sending}
      ><ArrowUp size={17} /></button>
    </div>
    <small>Local-only v1. No keys, signatures or private runtime state are shared.</small>
  </form>
</section>
