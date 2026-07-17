<script lang="ts">
  import { Clock3, GitBranch, ShieldCheck } from 'lucide-svelte';
  import type { EntityConsensusSettingsView } from './entity-consensus-settings';

  export let view: EntityConsensusSettingsView;

  const shortHash = (value: string): string =>
    value ? (value.length > 22 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value) : '-';

  const timestamp = (value: number | null): string => {
    if (value === null || value <= 0) return '-';
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return new Date(milliseconds).toISOString();
  };

  const tokenLabel = (tokenId: number, symbol: string | null, name: string | null): string => {
    const trustedName = [name, symbol].filter((value, index, values) => value && values.indexOf(value) === index).join(' · ');
    return trustedName ? `${trustedName} · #${tokenId}` : `Token #${tokenId}`;
  };
</script>

<section class="consensus" data-testid="settings-consensus-panel">
  <div class="summary-grid">
    <article>
      <span>Runtime height</span>
      <strong>R{view.runtimeHeight}</strong>
    </article>
    <article>
      <span>Entity height</span>
      <strong>E{view.entityHeight}</strong>
      <small>{timestamp(view.entityTimestamp)}</small>
    </article>
    <article>
      <span>J finalized / scanned</span>
      <strong>J{view.lastFinalizedJHeight} / {view.scannedJHeight === null ? 'not projected' : `J${view.scannedJHeight}`}</strong>
    </article>
    <article>
      <span>Account machines</span>
      <strong>{view.accounts.length}</strong>
      <small>{view.accounts.filter((account) => account.pendingHeight !== null).length} pending</small>
    </article>
  </div>

  <div class="panel-grid">
    <section class="card">
      <header><ShieldCheck size={15} /><h3>Board</h3></header>
      <dl class="facts">
        <div><dt>Mode</dt><dd>{view.boardMode}</dd></div>
        <div><dt>Threshold</dt><dd>{view.threshold.toString()} / {view.totalShares.toString()}</dd></div>
        <div><dt>Leader view</dt><dd>{view.leaderView}</dd></div>
        <div><dt>Changed at</dt><dd>E{view.leaderChangedAtHeight}</dd></div>
      </dl>
      <div class="rows" data-testid="settings-consensus-board">
        {#each view.board as member (member.signerId)}
          <div class="row">
            <code title={member.signerId}>{shortHash(member.signerId)}</code>
            <span>{member.shares.toString()} shares</span>
            {#if member.isLeader}<b>leader</b>{/if}
            {#if member.isLocalSigner}<b>this signer</b>{/if}
          </div>
        {/each}
      </div>
    </section>

    <section class="card">
      <header><GitBranch size={15} /><h3>Frame progress</h3></header>
      <dl class="facts">
        <div><dt>Parent hash</dt><dd title={view.entityFrameHash}>{shortHash(view.entityFrameHash)}</dd></div>
        <div><dt>J history root</dt><dd title={view.jHistoryRoot}>{shortHash(view.jHistoryRoot)}</dd></div>
        <div><dt>Proposed</dt><dd>{view.pendingFrameHeight === null ? '-' : `E${view.pendingFrameHeight}`}</dd></div>
        <div><dt>Locked</dt><dd>{view.lockedFrameHeight === null ? '-' : `E${view.lockedFrameHeight}`}</dd></div>
        <div><dt>Proposal hash</dt><dd title={view.pendingFrameHash ?? ''}>{shortHash(view.pendingFrameHash ?? '')}</dd></div>
        <div><dt>Locked hash</dt><dd title={view.lockedFrameHash ?? ''}>{shortHash(view.lockedFrameHash ?? '')}</dd></div>
        <div><dt>Last progress</dt><dd>{timestamp(view.lastConsensusProgressAt)}</dd></div>
        <div><dt>J prefix cert</dt><dd>{view.jPrefixCertified ? 'present' : 'none'}</dd></div>
      </dl>
      {#if !view.localDiagnosticsAvailable}
        <p class="projection-note">Validator-local locks and certificates are not exposed by this remote projection.</p>
      {/if}
    </section>
  </div>

  <section class="card">
    <header><GitBranch size={15} /><h3>Accounts</h3></header>
    <div class="table-wrap">
      <table data-testid="settings-consensus-accounts">
        <thead><tr><th>Counterparty</th><th>Account height</th><th>Timestamp</th><th>State hash</th><th>Pending</th></tr></thead>
        <tbody>
          {#each view.accounts as account (account.counterpartyId)}
            <tr>
              <td><code title={account.counterpartyId}>{shortHash(account.counterpartyId)}</code></td>
              <td>A{account.currentHeight}</td>
              <td>{timestamp(account.currentTimestamp)}</td>
              <td><code title={account.currentHash}>{shortHash(account.currentHash)}</code></td>
              <td>{account.pendingHeight === null ? '-' : `A${account.pendingHeight} · ${shortHash(account.pendingHash ?? '')}`}</td>
            </tr>
          {:else}
            <tr><td colspan="5" class="empty">No accounts in this projection.</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <div class="panel-grid">
    <section class="card">
      <header><ShieldCheck size={15} /><h3>Governance</h3></header>
      <div class="rows" data-testid="settings-consensus-proposals">
        {#each view.proposals as proposal (proposal.id)}
          <div class="proposal">
            <div><strong>{proposal.actionType}</strong><b class:ok={proposal.status === 'executed'}>{proposal.status}</b></div>
            <code title={proposal.id}>{shortHash(proposal.id)}</code>
            <small>{proposal.yesShares.toString()} yes · {proposal.noShares.toString()} no · {proposal.abstainShares.toString()} abstain · threshold {view.threshold.toString()}</small>
            {#each proposal.payments as payment, paymentIndex (`${proposal.id}:${paymentIndex}`)}
              <section
                class="payment-intent"
                data-testid="settings-consensus-payment"
                aria-label="Collective HTLC payment approval"
              >
                <div class="payment-intent-head">
                  <strong>HTLC payment approval</strong>
                  <b>{payment.deliveryMode}</b>
                </div>
                <dl class="payment-facts">
                  <div class="wide"><dt>Final recipient</dt><dd class="exact-id"><code>{payment.recipientEntityId}</code></dd></div>
                  <div><dt>Asset</dt><dd>{tokenLabel(payment.tokenId, payment.tokenSymbol, payment.tokenName)}</dd></div>
                  <div><dt>Recipient amount</dt><dd>{payment.recipientAmount.toString()}</dd></div>
                  <div><dt>Exact total debit</dt><dd>{payment.totalDebit.toString()}</dd></div>
                  <div><dt>Exact fee</dt><dd>{payment.totalFee.toString()}</dd></div>
                  <div class="wide"><dt>Hashlock</dt><dd class="exact-id"><code>{payment.hashlock}</code></dd></div>
                </dl>
              </section>
            {/each}
          </div>
        {:else}
          <p class="empty">No proposals.</p>
        {/each}
      </div>
    </section>

    <section class="card">
      <header><ShieldCheck size={15} /><h3>Certificates</h3></header>
      <dl class="facts">
        <div><dt>Leader votes</dt><dd>{view.leaderVoteCount}</dd></div>
        <div><dt>Leader certificate</dt><dd>{view.leaderCertificateVoteCount} votes</dd></div>
        <div><dt>Certified suffix</dt><dd>{view.certifiedLineageLength} frames</dd></div>
        <div><dt>Hanko witnesses</dt><dd>{view.hankoWitnessCount}</dd></div>
        <div><dt>Anchor</dt><dd>{view.certifiedAnchorHeight === null ? '-' : `E${view.certifiedAnchorHeight}`}</dd></div>
        <div><dt>Anchor hash</dt><dd title={view.certifiedAnchorHash ?? ''}>{shortHash(view.certifiedAnchorHash ?? '')}</dd></div>
      </dl>
    </section>
  </div>

  <section class="card">
    <header><Clock3 size={15} /><h3>Scheduled hooks</h3></header>
    <div class="rows" data-testid="settings-consensus-hooks">
      {#each view.hooks as hook (hook.id)}
        <div class="row"><strong>{hook.type}</strong><code title={hook.id}>{shortHash(hook.id)}</code><span>{timestamp(hook.triggerAt)}</span></div>
      {:else}
        <p class="empty">No scheduled hooks.</p>
      {/each}
    </div>
  </section>
</section>

<style>
  .consensus { display: grid; gap: 14px; }
  .summary-grid, .panel-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
  .summary-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .summary-grid article, .card { border: 1px solid color-mix(in srgb, var(--theme-card-border, #27272a) 82%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--theme-card-bg, #111113) 94%, transparent); padding: 14px; }
  .summary-grid article { display: grid; gap: 5px; }
  .summary-grid span, dt, small, .empty, .projection-note { color: var(--theme-text-muted, #71717a); font-size: 12px; }
  .summary-grid strong { color: var(--theme-text-primary, #f4f4f5); font: 800 17px 'SF Mono', monospace; }
  header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; color: var(--theme-text-secondary, #a1a1aa); }
  h3 { margin: 0; font-size: 12px; text-transform: uppercase; }
  .facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; margin: 0; }
  dt { font-weight: 700; }
  dd { margin: 3px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 13px 'SF Mono', monospace; }
  .rows { display: grid; gap: 8px; margin-top: 12px; }
  .row, .proposal { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; border-top: 1px solid color-mix(in srgb, var(--theme-card-border, #27272a) 70%, transparent); padding-top: 8px; }
  .row code { margin-right: auto; }
  b { border: 1px solid color-mix(in srgb, var(--theme-accent, #fbbf24) 35%, transparent); border-radius: 999px; color: var(--theme-accent, #fbbf24); font-size: 10px; padding: 3px 6px; text-transform: uppercase; }
  b.ok { color: #34d399; }
  .proposal { display: grid; }
  .proposal div { display: flex; justify-content: space-between; gap: 8px; }
  .payment-intent { display: grid; gap: 9px; margin-top: 4px; border: 1px solid color-mix(in srgb, var(--theme-accent, #fbbf24) 24%, var(--theme-card-border, #27272a)); border-radius: 7px; background: color-mix(in srgb, var(--theme-accent, #fbbf24) 4%, transparent); padding: 11px; }
  .payment-intent .payment-intent-head { align-items: center; }
  .payment-intent-head strong { color: var(--theme-text-primary, #f4f4f5); font-size: 12px; }
  .payment-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px 14px; margin: 0; }
  .proposal .payment-facts > div { display: block; }
  .payment-facts .wide { grid-column: 1 / -1; }
  .payment-facts .exact-id { overflow-wrap: anywhere; white-space: normal; }
  code { color: var(--theme-text-secondary, #a1a1aa); }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border-top: 1px solid color-mix(in srgb, var(--theme-card-border, #27272a) 70%, transparent); padding: 9px 10px; text-align: left; white-space: nowrap; }
  th { color: var(--theme-text-muted, #71717a); }
  .projection-note { margin: 12px 0 0; }
  @media (max-width: 820px) { .summary-grid, .panel-grid { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 560px) { .summary-grid, .panel-grid, .facts, .payment-facts { grid-template-columns: 1fr; } .payment-facts .wide { grid-column: auto; } }
</style>
