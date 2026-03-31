<script lang="ts">
  type RuntimeStateCardProps = {
    title: string;
    description: string;
    status: string | null;
    actionLabel: string | null;
    actionDisabled: boolean;
    onAction: (() => void) | null;
    testId?: string;
    compact?: boolean;
  };

  let {
    title,
    description,
    status,
    actionLabel,
    actionDisabled,
    onAction,
    testId,
    compact = false,
  }: RuntimeStateCardProps = $props();

  function handleAction(): void {
    if (onAction) onAction();
  }
</script>

<div class="runtime-state-card" class:compact data-testid={testId}>
  <div class="runtime-state-copy">
    <h1>{title}</h1>
    <p>{description}</p>
  </div>

  {#if status}
    <div class="runtime-state-status" aria-live="polite">
      <span class="runtime-state-dot"></span>
      <span>{status}</span>
    </div>
  {/if}

  {#if actionLabel}
    <button class="runtime-state-action" type="button" onclick={handleAction} disabled={actionDisabled}>
      {actionLabel}
    </button>
  {/if}
</div>

<style>
  .runtime-state-card {
    width: min(420px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 28px 24px;
    border: 1px solid color-mix(in srgb, var(--theme-border, rgba(255, 255, 255, 0.12)) 88%, transparent);
    border-radius: 18px;
    background: color-mix(in srgb, var(--theme-surface, var(--theme-card-bg, #18181b)) 94%, black);
    box-shadow:
      0 24px 64px color-mix(in srgb, black 36%, transparent),
      inset 0 1px 0 color-mix(in srgb, var(--theme-text-primary, white) 4%, transparent);
  }

  .runtime-state-card.compact {
    width: min(360px, 100%);
  }

  .runtime-state-copy {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .runtime-state-copy h1 {
    margin: 0;
    font-size: clamp(24px, 4vw, 30px);
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--theme-text-primary, #fafaf9);
  }

  .runtime-state-card.compact .runtime-state-copy h1 {
    font-size: 18px;
  }

  .runtime-state-copy p {
    margin: 0;
    max-width: 30ch;
    font-size: 14px;
    line-height: 1.5;
    color: color-mix(in srgb, var(--theme-text-secondary, #a1a1aa) 88%, transparent);
  }

  .runtime-state-status {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--theme-background, #09090b) 72%, var(--theme-surface, #18181b));
    border: 1px solid color-mix(in srgb, var(--theme-border, rgba(255, 255, 255, 0.12)) 72%, transparent);
    color: color-mix(in srgb, var(--theme-text-secondary, #a1a1aa) 88%, transparent);
    font-size: 12px;
  }

  .runtime-state-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--theme-accent, #facc15);
    box-shadow: 0 0 14px color-mix(in srgb, var(--theme-accent, #facc15) 66%, transparent);
    animation: runtime-state-pulse 1.6s ease-in-out infinite;
    flex: 0 0 auto;
  }

  .runtime-state-action {
    width: fit-content;
    padding: 10px 14px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--theme-danger, #ef4444) 24%, transparent);
    background: color-mix(in srgb, var(--theme-surface, var(--theme-card-bg, #18181b)) 92%, black);
    color: color-mix(in srgb, var(--theme-danger, #ef4444) 62%, white);
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease, transform 0.15s ease;
  }

  .runtime-state-action:hover:not(:disabled) {
    transform: translateY(-1px);
    color: color-mix(in srgb, var(--theme-danger, #ef4444) 48%, white);
    border-color: color-mix(in srgb, var(--theme-danger, #ef4444) 44%, transparent);
  }

  .runtime-state-action:disabled {
    opacity: 0.55;
    cursor: wait;
  }

  @keyframes runtime-state-pulse {
    0%, 100% { opacity: 0.72; transform: scale(0.98); }
    50% { opacity: 1; transform: scale(1.03); }
  }
</style>
