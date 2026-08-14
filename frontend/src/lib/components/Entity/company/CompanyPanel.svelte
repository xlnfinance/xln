<!--
  Canonical company lifecycle over existing Runtime commands. Registration,
  Account consensus, EntityProvider issuance, and trading remain separate
  durable stages; this panel never presents them as one atomic transaction.
-->
<script lang="ts">
  import { Building2, Check, CircleDollarSign, Landmark, LoaderCircle, ShieldCheck } from 'lucide-svelte';
  import type { CompanyShareTokenProjection } from './company-flow';

  export let companyName = '';
  export let entityId = '';
  export let isNumbered = false;
  export let activeIsLive = false;
  export let boardThreshold = 0n;
  export let boardMemberCount = 0;
  export let defaultHubName = '';
  export let hubConnected = false;
  export let hubOpening = false;
  export let shareTokens: readonly CompanyShareTokenProjection[] = [];
  export let releasePendingHash = '';
  export let releasePendingNonce: bigint | null = null;
  export let releaseConfirmedNonce = 0n;
  export let releaseBlocked = false;
  export let busyAction: 'hub' | 'release' | null = null;
  export let error = '';
  export let onJoinHub: () => void | Promise<void> = () => undefined;
  export let onReleaseShares: () => void | Promise<void> = () => undefined;
  export let onOpenTrading: () => void = () => undefined;
  export let onOpenPayments: () => void = () => undefined;
  export let onOpenGovernance: () => void = () => undefined;

  $: control = shareTokens.find((token) => token.shareClass === 'control') ?? null;
  $: dividend = shareTokens.find((token) => token.shareClass === 'dividend') ?? null;
  $: sharesInTreasury = (control?.reserve ?? 0n) > 0n || (dividend?.reserve ?? 0n) > 0n;
  $: releaseSubmitted = Boolean(releasePendingHash) || sharesInTreasury;

  const compact = (value: string): string => value.length <= 18
    ? value
    : `${value.slice(0, 10)}…${value.slice(-6)}`;
</script>

<div class="company" data-testid="company-panel">
  <header class="hero">
    <div class="mark"><Building2 size={22} /></div>
    <div>
      <p class="eyebrow">Company</p>
      <h2>{companyName || 'Company entity'}</h2>
      <code>{compact(entityId)}</code>
    </div>
    <span class:ready={isNumbered}>{isNumbered ? 'registered' : 'numbered entity required'}</span>
  </header>

  {#if !isNumbered}
    <div class="notice warn">Company shares and on-chain governance require a numbered Entity.</div>
  {:else}
    <div class="facts">
      <div><small>Board</small><strong>{boardMemberCount} member{boardMemberCount === 1 ? '' : 's'}</strong></div>
      <div><small>Threshold</small><strong>{boardThreshold.toString()}</strong></div>
      <div><small>Hub account</small><strong>{hubConnected ? 'ready' : hubOpening ? 'opening' : 'not opened'}</strong></div>
    </div>

    <section class="lifecycle" aria-label="Company setup stages">
      <article class:done={hubConnected}>
        <div class="step-icon">{#if hubConnected}<Check size={16} />{:else}<Landmark size={16} />{/if}</div>
        <div class="copy">
          <strong>1. Join one default hub</strong>
          <p>{hubConnected ? `Connected to ${defaultHubName || 'hub'}.` : hubOpening ? 'Account proposal is awaiting bilateral completion.' : defaultHubName ? `Open the company Account with ${defaultHubName}.` : 'No eligible same-jurisdiction hub is available.'}</p>
        </div>
        {#if !hubConnected}
          <button data-testid="company-join-hub" disabled={!activeIsLive || !defaultHubName || hubOpening || busyAction !== null} on:click={onJoinHub}>
            {#if busyAction === 'hub'}<LoaderCircle class="spin" size={14} />{/if}
            {hubOpening ? 'Opening…' : 'Join hub'}
          </button>
        {/if}
      </article>

      <article class:done={sharesInTreasury}>
        <div class="step-icon">{#if sharesInTreasury}<Check size={16} />{:else}<CircleDollarSign size={16} />{/if}</div>
        <div class="copy">
          <strong>2. Issue CONTROL + DIVIDEND</strong>
          <p>{sharesInTreasury ? 'Shares are held in the company Depository reserve.' : releaseSubmitted ? 'Board action submitted; waiting for signatures and chain receipt.' : 'One board action sends both classes to Depository; its callback registers the exact token IDs.'}</p>
          {#if releasePendingHash}
            <code>action {compact(releasePendingHash)} · nonce {releasePendingNonce?.toString() ?? '—'}</code>
          {:else if sharesInTreasury && releaseConfirmedNonce > 0n}
            <code>confirmed nonce {releaseConfirmedNonce.toString()}</code>
          {/if}
        </div>
        {#if !releaseSubmitted}
          <button data-testid="company-release-shares" disabled={!activeIsLive || releaseBlocked || busyAction !== null} on:click={onReleaseShares}>
            {#if busyAction === 'release'}<LoaderCircle class="spin" size={14} />{/if}
            Issue shares
          </button>
        {/if}
      </article>

      <article class:done={sharesInTreasury && hubConnected}>
        <div class="step-icon"><CircleDollarSign size={16} /></div>
        <div class="copy"><strong>3. Trade and buy back</strong><p>CONTROL/USDT and DIVIDEND/USDT books begin with the first committed offer. A buyback is an ordinary company swap.</p></div>
        <button data-testid="company-open-trading" disabled={!hubConnected || !sharesInTreasury} on:click={onOpenTrading}>Open trading</button>
      </article>
    </section>

    <div class="quick-actions">
      <button on:click={onOpenPayments}><CircleDollarSign size={15} /> Pay from company</button>
      <button on:click={onOpenGovernance}><ShieldCheck size={15} /> Board & takeover</button>
    </div>

    <p class="boundary">Each green step is independently committed. Company setup never claims EVM registration and bilateral Account consensus are atomic.</p>
  {/if}

  {#if error}<div class="notice error" role="alert">{error}</div>{/if}
</div>

<style>
  .company { display: grid; gap: 18px; max-width: 920px; margin: 0 auto; }
  .hero { display: flex; align-items: center; gap: 12px; padding: 18px; border: 1px solid var(--theme-border, #2b2b30); border-radius: 16px; background: color-mix(in srgb, var(--theme-surface, #18181b) 92%, transparent); }
  .mark { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; color: var(--theme-accent, #fbbf24); background: color-mix(in srgb, var(--theme-accent, #fbbf24) 14%, transparent); }
  .hero div:nth-child(2) { min-width: 0; flex: 1; }
  .hero h2, .hero p { margin: 0; }
  .hero h2 { margin: 2px 0 4px; font-size: 18px; }
  .hero code, .copy code { color: var(--theme-text-muted, #8b8b94); font-size: 10px; }
  .eyebrow, small { color: var(--theme-text-muted, #8b8b94); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
  .hero > span { padding: 5px 9px; border-radius: 999px; color: #fca5a5; background: #7f1d1d33; font-size: 10px; white-space: nowrap; }
  .hero > span.ready { color: #86efac; background: #14532d55; }
  .facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .facts div { display: grid; gap: 4px; padding: 12px; border-radius: 12px; background: color-mix(in srgb, var(--theme-surface, #18181b) 82%, transparent); }
  .facts strong { font-size: 12px; }
  .lifecycle { display: grid; gap: 8px; }
  article { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 14px; border: 1px solid var(--theme-border, #2b2b30); border-radius: 14px; }
  article.done { border-color: color-mix(in srgb, #22c55e 40%, var(--theme-border, #2b2b30)); }
  .step-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; color: var(--theme-text-muted, #8b8b94); background: color-mix(in srgb, var(--theme-surface, #18181b) 80%, transparent); }
  article.done .step-icon { color: #86efac; background: #14532d44; }
  .copy strong { font-size: 12px; }
  .copy p { margin: 4px 0; color: var(--theme-text-muted, #8b8b94); font-size: 11px; line-height: 1.45; }
  button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; padding: 7px 11px; border: 1px solid var(--theme-border, #2b2b30); border-radius: 9px; color: var(--theme-text-primary, #f4f4f5); background: color-mix(in srgb, var(--theme-surface, #18181b) 88%, transparent); cursor: pointer; font-size: 11px; }
  button:hover:not(:disabled) { border-color: var(--theme-accent, #fbbf24); }
  button:disabled { opacity: .42; cursor: not-allowed; }
  .quick-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .boundary { margin: 0; color: var(--theme-text-muted, #8b8b94); font-size: 10px; line-height: 1.5; }
  .notice { padding: 10px 12px; border-radius: 10px; font-size: 11px; }
  .notice.warn { color: #fde68a; background: #78350f44; }
  .notice.error { color: #fecaca; background: #7f1d1d44; }
  @media (max-width: 640px) {
    .hero { align-items: flex-start; }
    .hero > span { max-width: 110px; white-space: normal; text-align: center; }
    .facts { grid-template-columns: 1fr; }
    article { grid-template-columns: auto minmax(0, 1fr); }
    article button { grid-column: 1 / -1; }
    .quick-actions { grid-template-columns: 1fr; }
  }
</style>
