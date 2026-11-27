<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import type { RuntimeInput, EntityTx, RuntimeAdapterViewFrame } from '@xln/core/api/public/runtime-module';
  import { asTokenDecimals } from '@xln/core/account/tx/units';
  import { LENDING_TERM_MS } from '@xln/core/lendbook/state';
  import { deriveDelta } from '@xln/core/account/utils';
  import type { EntityReadView } from '../core/entity-panel-types';
  import { runtimeAdapter, getRuntimeControllerConfig, isRuntimeControllerConfigCurrent } from '#lib/stores/runtimeControllerStore.ts';
  import { resolveConfiguredApiBase, xlnFunctions } from '#lib/stores/xlnStore.ts';
  import { runtimeHttpOriginFromWsUrl } from '#lib/utils/runtime/wsUrl.ts';
  import { requireUnknownRecord } from '#lib/utils/boundary/index.ts';
  import { LENDING_TERMS, bankOfferFor, previewLendingTerms, previewSavingsRisk, decodeLendingState,
    buildLendingOfferTx, buildLendingBorrowTx, buildLendingRepayTx, isLendingLoanRepayable,
    type LendingState, type LendingLoan, type TermId } from '@xln/core/presentation/lending';
  import { parseAmount, formatAmount } from '@xln/core/presentation/amount';
  import { requestCreditFacility } from '@xln/core/presentation/credit-officer/request';

  export let entityId: string;
  export let replica: EntityReadView | null = null;
  export let accountIds: string[] = [];
  export let entityNames: Map<string, string> = new Map();
  export let isLive = false;
  export let submitRuntimeInput: ((input: RuntimeInput) => Promise<unknown> | unknown) | null = null;
  let hubId = '';
  let tokenId = 1;
  let termId: TermId = 'demand';
  let side: 'lend' | 'borrow' = 'lend';
  let amount = '';
  let maxRate = '250';
  let busy = false;
  let error = '';
  let notice = '';
  let requestId: string | undefined;
  let repayAmounts: Record<string, string> = {};
  type AccountDoc = NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number];
  let accountSnapshot: { key: string; doc: AccountDoc } | null = null;
  let snapshot: { key: string; state: LendingState } | null = null;
  let refreshVersion = 0;
  let lastKey = '';
  let actionContext: { key: string; entityId: string; signerId: string; config: ReturnType<typeof getRuntimeControllerConfig> } | null = null;
  $: if (side === 'borrow' && termId === 'demand') termId = '1d';
  $: key = `${entityId}:${hubId}:${tokenId}`;
  $: state = snapshot?.key === key ? snapshot.state : null;
  $: if (!accountIds.includes(hubId)) hubId = accountIds[0] ?? '';
  $: account = accountSnapshot?.key === key ? accountSnapshot.doc : undefined;
  $: meta = $xlnFunctions?.getTokenInfo(tokenId);
  $: decimals = meta ? asTokenDecimals(meta.decimals) : null;
  $: offer = account && state ? bankOfferFor(state.terms, account.state.domain, tokenId, termId, Date.now()) : { kind: 'none' as const };
  $: terms = offer.kind === 'active' ? offer.terms : undefined;
  $: quote = decimals === null ? null : previewLendingTerms(amount, side === 'lend' ? String(terms?.savingsInterestBps ?? '') : maxRate,
    decimals, side === 'borrow' && terms ? { termMs: LENDING_TERM_MS[termId], lateMs: terms.loanLateMs } : undefined);
  $: risk = account && terms && decimals !== null && side === 'lend'
    ? previewSavingsRisk({ doc: account, isLeft: account.state.leftEntity === entityId }, tokenId, amount, String(terms.savingsInterestBps), decimals) : null;
  $: delta = account?.state.deltas.get(tokenId);
  $: capacity = delta && account ? deriveDelta(delta, account.state.leftEntity === entityId).inCapacity : 0n;
  $: needsRisk = risk?.ok === true && risk.requiredLimit > risk.currentLimit;
  $: receivePlan = account && quote?.ok && $xlnFunctions ? $xlnFunctions.planReceiveCapacity({ account: account.state, ownerEntityId: entityId, counterpartyEntityId: hubId, tokenId, requiredInboundAmount: quote.principal, collateralPercent: 0, creditBufferBps: 0, allowOpenAccount: false }) : null;
  $: needsCapacity = side === 'borrow' && quote?.ok === true && quote.principal > capacity;
  $: ready = isLive && !!replica?.signerId && !!submitRuntimeInput && !!terms && !!meta && !!account && !account.activeDispute;
  $: if (key !== lastKey) { lastKey = key; requestId = undefined; snapshot = null; void refresh(); }

  function apiBase() {
    const config = getRuntimeControllerConfig();
    if (!config) throw new Error('LENDING_RUNTIME_CONTROLLER_NOT_CONNECTED');
    if (config.mode === 'remote') {
      if (!config.wsUrl) throw new Error('LENDING_REMOTE_URL_MISSING');
      return runtimeHttpOriginFromWsUrl(config.wsUrl);
    }
    return resolveConfiguredApiBase(window.location.origin);
  }
  async function readApi(path: string, params: Record<string, string>, body?: Record<string, unknown>) {
    const url = new URL(path, apiBase());
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    const response = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) } : { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const result = requireUnknownRecord(await response.json(), 'LENDING_RESPONSE_INVALID');
    if (!response.ok || result['success'] !== true) throw new Error(String(result['error'] ?? `Lending HTTP ${response.status}`));
    return result;
  }
  async function refresh() {
    const version = ++refreshVersion;
    if (!isLive || !entityId || !hubId) return;
    const selected = { key, hubId, entityId, tokenId, requestId, config: getRuntimeControllerConfig() };
    try {
      const url = new URL('/api/lending/state', apiBase());
      for (const [name, value] of Object.entries({ hubEntityId: hubId, userEntityId: entityId, tokenId: String(tokenId), ...(requestId ? { requestId } : {}) })) url.searchParams.set(name, value);
      const response = await fetch(url, { cache: 'no-store' });
      const result = requireUnknownRecord(await response.json(), 'LENDING_RESPONSE_INVALID');
      if (!response.ok || result['success'] !== true) throw new Error(String(result['error'] ?? `Lending HTTP ${response.status}`));
      const decoded = decodeLendingState(result, { hubEntityId: selected.hubId, ...(selected.requestId ? { requestId: selected.requestId } : {}) });
      const adapter = get(runtimeAdapter);
      if (!adapter) throw new Error('LENDING_RUNTIME_ADAPTER_MISSING');
      const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: selected.entityId });
      const doc = frame.activeEntity?.accounts.items.find(value => value.state.leftEntity === selected.hubId || value.state.rightEntity === selected.hubId);
      if (!doc || frame.activeEntity?.summary.entityId !== selected.entityId) throw new Error('LENDING_ACCOUNT_VIEW_MISSING');
      if (version !== refreshVersion || key !== selected.key || !selected.config || !isRuntimeControllerConfigCurrent(selected.config)) return;
      accountSnapshot = { key, doc };
      snapshot = { key, state: decoded };
      error = '';
    } catch (cause) { if (version === refreshVersion && key === selected.key) error = cause instanceof Error ? cause.message : String(cause); }
  }
  onMount(() => {
    void refresh();
    const timer = setInterval(() => { if (!busy) void refresh(); }, 2000);
    return () => { clearInterval(timer); refreshVersion++; actionContext = null; };
  });
  async function sendAll(txs: EntityTx[]) {
    if (!isLive || !replica?.signerId || !submitRuntimeInput) throw new Error('LENDING_SIGNER_UNAVAILABLE');
    // The selected Entity signer authorizes the request through ordinary Runtime admission.
    // A read-only or different Entity selection must never borrow or debit this wallet.
    if (replica.entityId !== entityId) throw new Error('LENDING_SIGNER_ENTITY_MISMATCH');
    if (!actionContext || actionContext.key !== key || actionContext.entityId !== entityId || actionContext.signerId !== replica.signerId || !actionContext.config || !isRuntimeControllerConfigCurrent(actionContext.config)) throw new Error('LENDING_SELECTION_CHANGED');
    await submitRuntimeInput({ runtimeTxs: [], entityInputs: [{ entityId, signerId: replica.signerId, entityTxs: txs }], jInputs: [] });
    for (const tx of txs) if (tx.type === 'lendingBorrow') requestId = tx.data.requestId;
    notice = 'Request submitted. Only the committed position and balance confirm completion.';
    await refresh();
  }
  const send = (tx: EntityTx) => sendAll([tx]);
  async function action(run: () => Promise<void>) {
    if (busy) return;
    actionContext = { key, entityId, signerId: replica?.signerId ?? '', config: getRuntimeControllerConfig() };
    busy = true; error = ''; notice = '';
    try { await run(); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; actionContext = null; }
  }
  function hasFacility(principal: bigint, term: Exclude<TermId, 'demand'>) {
    return state?.facilities.some(facility => facility.borrowerEntityId === entityId && facility.tokenId === tokenId && facility.termId === term && facility.maxPrincipal >= principal && facility.expiresAt > Date.now() && facility.jNonce === account?.state.jNonce) === true;
  }
  async function ensureFacility(principal: bigint, term: Exclude<TermId, 'demand'>) {
    if (hasFacility(principal, term)) return;
    const selectedKey = key;
    const requested = await requestCreditFacility({ hubEntityId: hubId, borrowerEntityId: entityId, tokenId, amount: principal, termId: term }, text => { notice = text; }, { getJson: (path, params) => readApi(path, params), postJson: (path, body) => readApi(path, {}, body) });
    if (!requested) return;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (key !== selectedKey) throw new Error('LENDING_SELECTION_CHANGED');
      await refresh();
      if (error) throw new Error(error);
      if (hasFacility(principal, term)) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('LENDING_FACILITY_COMMIT_TIMEOUT');
  }
  async function submit() {
    if (!ready || !terms || !meta || decimals === null || needsRisk || needsCapacity || !quote?.ok) throw new Error('LENDING_TERMS_NOT_READY');
    const principal = parseAmount(amount, decimals);
    if (side === 'lend') return send(buildLendingOfferTx({ hubEntityId: hubId, tokenId, amount: principal, termId, interestBps: terms.savingsInterestBps }));
    if (termId !== 'demand') await ensureFacility(principal, termId);
    await send(buildLendingBorrowTx({ hubEntityId: hubId, tokenId, amount: principal, termId, maxInterestBps: Number(maxRate), maxLateMs: terms.loanLateMs }));
  }
  async function repay(loan: LendingLoan) {
    if (decimals === null) throw new Error('LENDING_TOKEN_METADATA_REQUIRED');
    const value = repayAmounts[loan.loanId]?.trim();
    await send(buildLendingRepayTx(loan, entityId, value ? parseAmount(value, decimals) : undefined));
    repayAmounts = { ...repayAmounts, [loan.loanId]: '' };
  }
  function money(value: bigint) {
    if (!meta || decimals === null) throw new Error('LENDING_TOKEN_METADATA_REQUIRED');
    return `${formatAmount(value, decimals)} ${meta.symbol}`;
  }
  async function authorizeCapacity() {
    if (!receivePlan || receivePlan.status !== 'credit') throw new Error('LENDING_RECEIVE_PLAN_CHANGED');
    await sendAll([...receivePlan.setupTxs]);
  }
  async function authorizeRisk() {
    if (!risk?.ok) throw new Error('LENDING_RISK_UNAVAILABLE');
    await send({ type: 'extendCredit', data: { counterpartyEntityId: hubId, tokenId, amount: risk.requiredLimit } });
  }
</script>

<section class="lending-panel" data-testid="lending-panel">
  <h2>Lending</h2>
  <p>Savings are claims against the bank. Only collateral secures recovery. Review the signed terms and maximum exposure before submitting.</p>
  <label for="lending-bank">Bank</label><select id="lending-bank" bind:value={hubId} disabled={busy}>{#each accountIds as id}<option value={id}>{entityNames.get(id) ?? id}</option>{/each}</select>
  <label for="lending-token">Token</label><select id="lending-token" bind:value={tokenId} disabled={busy}>{#each Array.from(account?.state.deltas.keys() ?? []) as id}<option value={id}>{$xlnFunctions?.getTokenInfo(id).symbol ?? id}</option>{/each}</select>
  <label for="lending-action">Action</label><select id="lending-action" bind:value={side} disabled={busy}><option value="lend">Lend</option><option value="borrow">Borrow</option></select>
  <label for="lending-term">Term</label><select id="lending-term" bind:value={termId} disabled={busy}>{#each LENDING_TERMS.filter(term => side === 'lend' || term.id !== 'demand') as term}<option value={term.id}>{term.label}</option>{/each}</select>
  {#if !terms}<p role="status">This bank has no current signed offer for this token and term.</p>{/if}
  {#if terms}<p>Bank savings rate: {terms.savingsInterestBps} basis points {termId === 'demand' ? 'per year, simple interest' : 'per term'}. Offer expires {new Date(terms.expiresAt).toLocaleString()}.</p>{/if}
  <form on:submit|preventDefault={() => action(submit)} data-testid={side === 'lend' ? 'lending-offer-form' : 'lending-borrow-form'}>
    <label>Amount <input placeholder="Amount" inputmode="decimal" bind:value={amount} disabled={busy} /></label>
    {#if side === 'borrow'}<label>Maximum rate (basis points) <input type="number" min="0" step="1" bind:value={maxRate} disabled={busy} /></label>{/if}
    {#if quote?.ok}<p data-testid="lending-borrow-preview">Principal: {money(quote.principal)}. Maximum repayment: {money(quote.maximum)}.</p>{:else if quote}<p role="alert">{quote.error}</p>{/if}
    {#if needsRisk && risk?.ok}
      <p>Current maximum unsecured risk: {money(risk.currentLimit)}. This deposit requires {money(risk.requiredLimit)} across all Account obligations.</p>
      <button type="button" disabled={!ready || busy} on:click={() => action(authorizeRisk)}>Authorize this maximum risk</button>
    {/if}
    {#if needsCapacity}<p>Receiving this loan requires capacity. Accepting it as credit exposes you to the bank up to the displayed limit; collateral is the secured option.</p>
      {#if receivePlan?.status === 'credit'}<button type="button" disabled={!ready || busy} on:click={() => action(authorizeCapacity)}>Accept as credit: maximum {money(receivePlan.requiredPeerCreditLimit)}</button>{/if}
    {/if}
    <button type="submit" data-testid={side === 'lend' ? 'lending-offer-submit' : 'lending-borrow-submit'} disabled={!ready || busy || !quote?.ok || needsRisk || needsCapacity}>{side === 'lend' ? 'Lend' : 'Borrow'}</button>
  </form>
  {#if error}<p role="alert" data-testid="lending-error">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  <button type="button" on:click={() => refresh()} disabled={busy}>Refresh lending state</button>
  <h3>Savings</h3>
  {#each state?.savings.filter(pool => pool.lenderEntityId === entityId) ?? [] as pool (pool.positionId)}
    <article><p>{money(pool.principalAmount)} · {pool.status} · withdrawal {money(pool.closeAmount)}</p>
      {#if pool.status === 'queued'}<p>Withdrawal queued until the bank can pay. The claim remains owed.</p>{/if}
      <button disabled={!isLive || busy || pool.status !== 'open'} on:click={() => action(() => send({ type: 'lendingClosePosition', data: { hubEntityId: hubId, positionId: pool.positionId } }))}>Withdraw</button>
    </article>
  {/each}
  <h3>Loans</h3>
  {#each state?.loans.filter(loan => loan.borrowerEntityId === entityId) ?? [] as loan (loan.loanId)}
    <article data-testid="lending-loan-row"><p>{money(loan.principalAmount)} · {loan.status} · due {new Date(loan.dueAt).toLocaleString()}</p>
      <p>Repaid {money(loan.repaidAmount)} of {money(loan.repaymentAmount)}.</p>
      <label>Repayment amount (blank for full repayment) <input data-testid="lending-repay-amount" inputmode="decimal" bind:value={repayAmounts[loan.loanId]} disabled={busy || !isLendingLoanRepayable(loan)} /></label>
      <button data-testid="lending-repay-submit" disabled={!isLive || busy || !isLendingLoanRepayable(loan)} on:click={() => action(() => repay(loan))}>Repay</button>
    </article>
  {/each}
</section>
<style>
  .lending-panel { display: grid; gap: 14px; padding: 20px; max-width: 760px; }
  label { display: grid; gap: 6px; } input, select, button { font: inherit; padding: 10px; }
  form, article { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--border-color, #444); border-radius: 12px; }
  [role=alert] { color: var(--color-error, #ff8080); } button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; }
</style>
