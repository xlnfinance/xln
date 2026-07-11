<script lang="ts">
  import DeltaCapacityBar from '$lib/components/Entity/shared/DeltaCapacityBar.svelte';
  import type {
    MicroscopeAccountDisplay,
    MicroscopeExternalFlow,
    MicroscopeNodeDisplay,
  } from './microscope-visual-types';
  import './rcpan-account-microscope.css';

  export let display: MicroscopeAccountDisplay;

  function validateNode(node: MicroscopeNodeDisplay): void {
    if (!node.id || !node.name) throw new Error('RCPAN microscope node requires id and name');
    if (!node.color) throw new Error(`RCPAN microscope ${node.id} requires a node color`);
    if (!Number.isFinite(node.reserveRadiusPx) || node.reserveRadiusPx <= 0) {
      throw new Error(`RCPAN microscope ${node.id} reserveRadiusPx must be positive`);
    }
    if (node.tokens.length > 4) throw new Error(`RCPAN microscope ${node.id} supports at most 4 reserve tokens`);
  }

  function validateFlow(flow: MicroscopeExternalFlow, name: string): void {
    if (!flow.visible) return;
    if (!flow.sourceLabel || !flow.actionLabel || !flow.amountLabel) {
      throw new Error(`RCPAN microscope ${name} flow requires visible labels`);
    }
  }

  function validateDisplay(value: MicroscopeAccountDisplay): void {
    validateNode(value.left);
    validateNode(value.right);
    if (value.lanes.length === 0 || value.lanes.length > 4) {
      throw new Error('RCPAN microscope requires 1 to 4 token lanes');
    }
    const keys = value.lanes.map((lane) => lane.tokenKey);
    if (new Set(keys).size !== keys.length) throw new Error('RCPAN microscope token lane keys must be unique');
    for (const lane of value.lanes) {
      const packet = lane.payment;
      if (!Number.isFinite(packet.progressPercent) || packet.progressPercent < 0 || packet.progressPercent > 100) {
        throw new Error(`RCPAN microscope ${lane.tokenKey} packet progress must be 0..100`);
      }
      if (!Number.isFinite(packet.durationMs) || packet.durationMs <= 0 || !Number.isFinite(packet.delayMs)) {
        throw new Error(`RCPAN microscope ${lane.tokenKey} packet timing is invalid`);
      }
    }
    validateFlow(value.treasuryTopUp, 'Treasury top-up');
    validateFlow(value.enforceDebt, 'Enforce debt');
    if (!value.palette.proof || !value.palette.danger) {
      throw new Error('RCPAN microscope requires proof and danger colors');
    }
  }

  $: validateDisplay(display);
</script>

<section
  class="account-microscope"
  class:is-disputed={display.dispute.active}
  style={`--microscope-proof:${display.palette.proof};--microscope-danger:${display.palette.danger}`}
  aria-label={display.title}
>
  <header class="microscope-heading">
    <div>
      <span>Live account microscope</span>
      <h3>{display.title}</h3>
    </div>
    <p>{display.caption}</p>
  </header>

  <div class="microscope-stage">
    {#if display.treasuryTopUp.visible}
      <div
        class="external-flow treasury-flow target-{display.treasuryTopUp.target}"
        style={`--flow-color:${display.treasuryTopUp.color}`}
        data-testid="microscope-reserve-flow"
      >
        <span class="flow-source">{display.treasuryTopUp.sourceLabel}</span>
        <span class="flow-copy">
          <b>{display.treasuryTopUp.actionLabel}</b>
          <small>{display.treasuryTopUp.amountLabel} {display.treasuryTopUp.tokenSymbol}</small>
        </span>
        <i class="flow-arrow" aria-hidden="true"></i>
      </div>
    {/if}

    <div class="node-column left-node">
      {@render Node(display.left)}
    </div>

    <div
      class="account-corridor proof-{display.proof.state}"
      class:dispute-active={display.dispute.active}
      data-testid="microscope-account-edge"
    >
      <div class="proof-state">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 2.2 16 4.7v4.8c0 4-2.5 6.8-6 8.3-3.5-1.5-6-4.3-6-8.3V4.7L10 2.2Z" />
          {#if display.proof.state !== 'missing'}
            <path class="proof-check" d="m7 10 2 2 4-4" />
          {:else}
            <path class="proof-check" d="m7.2 7.2 5.6 5.6m0-5.6-5.6 5.6" />
          {/if}
        </svg>
        <span><b>{display.proof.label}</b><small>{display.proof.detail}</small></span>
      </div>

      <div class="token-lanes" style={`--lane-count:${display.lanes.length}`}>
        {#each display.lanes as lane (lane.tokenKey)}
          <div class="token-lane" style={`--token-color:${lane.color}`}>
            <span class="token-chip"><i></i>{lane.symbol}</span>
            <div class="lane-bar">
              <DeltaCapacityBar
                derived={lane.derived}
                layout={lane.barLayout}
                pendingOutDebtMode={lane.pendingOutDebtMode}
                heightPx={lane.barHeightPx}
                visualScale={lane.visualScale}
                presentation={lane.barPresentation}
              />
            </div>
            {#if lane.payment.state !== 'hidden'}
              <div
                class="payment-packet {lane.payment.state} {lane.payment.direction}"
                style={`--packet-progress:${lane.payment.progressPercent}%`}
                aria-label={`${lane.payment.amountLabel} ${lane.symbol} payment`}
              >
                <i></i><span>{lane.payment.amountLabel}</span>
              </div>
            {/if}
          </div>
        {/each}
      </div>

      {#if display.dispute.active}
        <div class="dispute-flag initiator-{display.dispute.initiator}" data-testid="microscope-dispute-outline">
          <span>Dispute</span><b>{display.dispute.label}</b><small>{display.dispute.timeoutLabel}</small>
        </div>
      {/if}

      {#if display.debt.visible}
        <div class="debt-object tone-{display.debt.tone}" data-testid="microscope-debt-object">
          <span>{display.debt.label}</span>
          <b>{display.debt.amountLabel}</b>
          <small>{display.debt.detail}</small>
        </div>
      {/if}
    </div>

    <div class="node-column right-node">
      {@render Node(display.right)}
    </div>

    {#if display.enforceDebt.visible}
      <div
        class="external-flow enforcement-flow target-{display.enforceDebt.target}"
        style={`--flow-color:${display.enforceDebt.color}`}
        data-testid="microscope-enforce-flow"
      >
        <i class="flow-arrow" aria-hidden="true"></i>
        <span class="flow-copy">
          <b>{display.enforceDebt.actionLabel}</b>
          <small>{display.enforceDebt.amountLabel} {display.enforceDebt.tokenSymbol}</small>
        </span>
        <span class="flow-source">{display.enforceDebt.sourceLabel}</span>
      </div>
    {/if}
  </div>
</section>

{#snippet Node(node: MicroscopeNodeDisplay)}
  <article class="reserve-node" class:selected={node.selected} style={`--reserve-radius:${node.reserveRadiusPx}px;--node-color:${node.color}`}>
    <div class="reserve-orbit">
      <div class="reserve-core">
        <span>Reserve</span>
        <strong>{node.reserveLabel}</strong>
      </div>
    </div>
    <div class="node-identity">
      <b>{node.name}</b><span>{node.roleLabel}</span><small>{node.reserveCaption}</small>
    </div>
    <div class="node-token-reserves" aria-label={`${node.name} token reserves`}>
      {#each node.tokens as token (token.tokenKey)}
        <span style={`--token-color:${token.color}`}><i></i><b>{token.symbol}</b>{token.amountLabel}</span>
      {/each}
    </div>
  </article>
{/snippet}
