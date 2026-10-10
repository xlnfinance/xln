<script lang="ts">
  import { onMount } from 'svelte';
  import { WALLET_LESSONS } from '#lib/tutorial/curriculum.ts';
  import { getJurisdictionBadgeInfo } from '#lib/utils/identity/jurisdictionBadge.ts';
  import '#lib/utils/identity/jurisdiction-theme.css';
  export let name = '';
  export let chainId: number | undefined = undefined;
  export let depository = '';
  export let entityProvider = '';
  export let onNavigate: (route: string, lessonId: string) => void;
  export let onCreateEntity: () => void;
  const key = 'xln-wallet-tutorial-chapter';
  const activeKey = 'xln-wallet-tutorial-active';
  let active = false;
  let index = 0;
  $: lesson = WALLET_LESSONS[index]!;
  $: badge = getJurisdictionBadgeInfo(name, chainId);
  const hints: Record<string, string> = {
    faucet: 'In Assets choose USDC, then Account in the faucet bar. External funds go to your blockchain wallet; Reserve funds stay in the contract. Wait for 100 USDC available to pay.',
    pay: 'Enter H2 in your current jurisdiction and 25 USDC. Choose Find routes first, inspect the route and fee, then Pay now. Open the confirmed receipt.',
    cross: 'In Swap choose From network and To network, then From token and To token. A USDC → USDT pair may have a direct market even when WETH does not. Inspect the route and minimum receive, submit a small test order and stay online. Inspect both legs; use Clear + Close when available. An unmatched order is not a completed swap.',
    receive: 'Enter 5 USDC. Copy the browser payment link and open it in a second funded test wallet. An invoice alone has not paid you: wait for the incoming receipt and updated balance.',
    borrow: 'Use the Borrow form. Enter 2 USDC, select the term and maximum rate. Read the maximum repayment before submitting. Find the approved loan below; a pending request has not paid you.',
    recovery: 'In a separate browser profile, derive the exact same BrainVault name and secret, then choose Restore selected backup before Start. Use the same tower. Compare identity and balance, send 1 test USDC, reload and verify it remains paid.',
    company: 'In Assets get test gas first. Choose Create an entity, enter a name and choose a registered Entity. Use Shared board only after arranging the other signers and their approval threshold. Verify the jurisdiction and select the created company.',
    governance: 'Open CONTROL governance and select an eligible disposable Target Entity. Refresh its status. Review Propose this signer as board and the activation time. Only activate after eligibility and the delay; verify the confirmed board.',
  };
  $: instruction = hints[lesson.id] ?? lesson.exercise;
  onMount(() => {
    active = localStorage.getItem(activeKey) === 'true';
    const stored = Number(localStorage.getItem(key) || '0');
    index = Number.isInteger(stored) ? Math.max(0, Math.min(stored, WALLET_LESSONS.length - 1)) : 0;
  });
  function setActive(next: boolean) {
    active = next;
    localStorage.setItem(activeKey, String(next));
  }
  function select(next: number) {
    index = next;
    localStorage.setItem(key, String(index));
    onNavigate(WALLET_LESSONS[index]!.route, WALLET_LESSONS[index]!.id);
  }
</script>

<aside class="jurisdiction-banner" data-testid="jurisdiction-banner" aria-label="Active jurisdiction">
  <div class="jurisdiction-heading">
    <span>Jurisdiction · <strong>{badge?.name ?? 'Select a network'}</strong></span>
    {#if chainId !== undefined}<span data-testid="jurisdiction-chain">Chain {chainId}</span>{/if}
    <button type="button" data-testid="wallet-tutorial" on:click={() => { setActive(!active); if (active) select(index); }}>{active ? 'Pause tutorial' : 'Tutorial · all features'}</button>
  </div>
  <details class="jurisdiction-stack" data-testid="jurisdiction-stack">
    <summary>Contract stack</summary>
    <p>This blockchain enforces the rules. Each stack has its own contracts and governance.</p>
    <p>Depository · <code>{depository || 'Not loaded'}</code></p>
    <p>Entity Provider · <code>{entityProvider || 'Not loaded'}</code></p>
  </details>
</aside>
{#if active}
  <section class="wallet-guide" data-testid="tour" data-step={lesson.id} aria-label="Wallet tutorial">
    <header><span>{index + 1} / {WALLET_LESSONS.length}</span><button type="button" data-testid="tour-exit" aria-label="Pause tutorial" on:click={() => setActive(false)}>×</button></header>
    <label>Chapter <select aria-label="Tutorial chapter" data-testid="tour-chapter" value={lesson.id} on:change={event => select(WALLET_LESSONS.findIndex(chapter => chapter.id === event.currentTarget.value))}>{#each WALLET_LESSONS as chapter, i}<option value={chapter.id}>{i + 1}. {chapter.title}</option>{/each}</select></label>
    <p class="lesson-value" data-testid="tour-value">{lesson.value}</p>
    <p data-testid="tour-prerequisite"><strong>Before you start: </strong>{lesson.prerequisite}</p>
    <p data-testid="tour-hint">{instruction}</p>
    <p data-testid="tour-result"><strong>Check the result: </strong>{lesson.outcome}</p>
    <details><summary>Why it works · example</summary><p>{lesson.example}</p></details>
    {#if lesson.id === 'company'}<button type="button" data-testid="tour-create-company" on:click={onCreateEntity}>Create an entity</button>{/if}
    <footer>
      <button type="button" disabled={index === 0} on:click={() => select(index - 1)}>Previous</button>
      {#if index < WALLET_LESSONS.length - 1}<button type="button" data-testid="tour-advance" on:click={() => select(index + 1)}>Next chapter</button>
      {:else}<button type="button" data-testid="tour-next" on:click={() => setActive(false)}>Finish guide</button>{/if}
    </footer>
    <small>Explore at your pace. Only confirmed receipts and balances prove an operation completed.</small>
  </section>
{/if}
<style>
  .wallet-guide { margin: 12px 20px; padding: 16px; border: 1px solid var(--jurisdiction-color); border-radius: 12px; background: var(--bg-secondary, #161b24); color: var(--text-primary, #e5e7eb); font-size: 13px; line-height: 1.5; }
  header, footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  header { margin-bottom: 8px; }
  label { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .lesson-value { font-weight: 600; }
  p { margin: 10px 0; max-width: 85ch; }
  select, button { font: inherit; color: inherit; background: transparent; border: 1px solid var(--border-color, #627084); border-radius: 6px; padding: 6px 10px; cursor: pointer; }
  select { max-width: 100%; background: var(--bg-secondary, #161b24); }
  button:disabled { opacity: 0.4; cursor: default; }
  summary { cursor: pointer; }
  footer { margin: 12px 0; }
  small { opacity: 0.8; }
  @media (max-width: 600px) { .wallet-guide { margin: 8px 12px; } }
</style>
