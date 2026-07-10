<script lang="ts">
  import {
    ArrowRightLeft,
    BadgeCheck,
    Braces,
    Landmark,
    Layers3,
    Scale,
    ShieldCheck,
    SlidersHorizontal,
    TriangleAlert,
    Zap,
  } from 'lucide-svelte';
  import './rcpan-system-comparison.css';

  type SystemId = 'xln' | 'channels' | 'rollups' | 'tradfi';
  type Icon = typeof ArrowRightLeft;
  type Cell = Readonly<{ lead: string; detail: string }>;
  type System = Readonly<{ id: SystemId; name: string; caption: string; icon: Icon }>;
  type ComparisonRow = Readonly<{
    label: string;
    icon: Icon;
    cells: Readonly<Record<SystemId, Cell>>;
  }>;

  const systems: readonly System[] = [
    { id: 'xln', name: 'xln', caption: 'Provable bilateral credit', icon: ShieldCheck },
    { id: 'channels', name: 'Lightning-style', caption: 'Full-reserve channels', icon: Zap },
    { id: 'rollups', name: 'EVM rollups', caption: 'Shared ordered state', icon: Layers3 },
    { id: 'tradfi', name: 'TradFi / RTGS', caption: 'Operator-led settlement', icon: Landmark },
  ];

  const rows: readonly ComparisonRow[] = [
    {
      label: 'Everyday update', icon: ArrowRightLeft,
      cells: {
        xln: { lead: 'Two parties sign', detail: 'The account updates between its participants.' },
        channels: { lead: 'Two parties sign', detail: 'The channel updates between its participants.' },
        rollups: { lead: 'A sequencer orders it', detail: 'The transaction joins shared L2 state.' },
        tradfi: { lead: 'The operator records it', detail: 'The institution controls its internal ledger.' },
      },
    },
    {
      label: 'Credit and collateral', icon: SlidersHorizontal,
      cells: {
        xln: { lead: 'Choose the mix', detail: 'Combine per-account credit with shared collateral.' },
        channels: { lead: 'Reserve first', detail: 'Capacity comes from funds locked in the channel.' },
        rollups: { lead: 'Application-specific', detail: 'Credit belongs to a separate contract or product.' },
        tradfi: { lead: 'Institution-defined', detail: 'Limits depend on the operator and its balance sheet.' },
      },
    },
    {
      label: 'Evidence you keep', icon: BadgeCheck,
      cells: {
        xln: { lead: 'Co-signed account proof', detail: 'Both sides hold the latest agreed account state.' },
        channels: { lead: 'Channel commitment', detail: 'The latest channel state can close on-chain.' },
        rollups: { lead: 'Shared state proof', detail: 'Exit follows the rollup data and proof rules.' },
        tradfi: { lead: 'Statement and law', detail: 'No bilateral crypto receipt in the FCUAN baseline.' },
      },
    },
    {
      label: 'Where rules run', icon: Braces,
      cells: {
        xln: { lead: 'Account first, EVM on dispute', detail: 'Fast updates stay bilateral; code settles conflict.' },
        channels: { lead: 'Channel close logic', detail: 'Lightning-style HTLC and close rules settle funds.' },
        rollups: { lead: 'Shared EVM execution', detail: 'Transactions execute inside the common L2 state.' },
        tradfi: { lead: 'Outside the RTGS rail', detail: 'Institutions and courts handle account disputes.' },
      },
    },
    {
      label: 'When cooperation stops', icon: Scale,
      cells: {
        xln: { lead: 'Settle this account', detail: 'Proof allocates collateral to reserves; shortfall becomes debt.' },
        channels: { lead: 'Close this channel', detail: "Locked funds follow the channel's close rules." },
        rollups: { lead: 'Use the L2 exit path', detail: 'Finality and withdrawal follow rollup and bridge rules.' },
        tradfi: { lead: 'Enter a legal process', detail: 'The FCUAN baseline has no code-enforced bilateral payout.' },
      },
    },
    {
      label: 'Honest tradeoff', icon: TriangleAlert,
      cells: {
        xln: { lead: 'Keep proof; choose exposure', detail: 'Credit above collateral remains counterparty risk.' },
        channels: { lead: 'Lock liquidity', detail: 'Receiving depends on available inbound balance.' },
        rollups: { lead: 'Share ordering and data', detail: "Users rely on the L2's common availability rules." },
        tradfi: { lead: 'Trust the operator', detail: 'Users rely on its records, controls, and reconciliation.' },
      },
    },
  ];
</script>

<section class="system-comparison" aria-labelledby="system-comparison-title">
  <header class="comparison-intro">
    <span>Architecture, in plain English</span>
    <h2 id="system-comparison-title">Why xln is a different kind of L2</h2>
    <p>Bank-style credit, payment-channel proofs, and programmable settlement in one account.</p>
  </header>

  <div class="comparison-matrix" role="table" aria-label="xln compared with payment channels, rollups, and traditional settlement">
    <div class="matrix-row matrix-head" role="row">
      <div class="matrix-criterion" role="columnheader">What matters</div>
      {#each systems as system (system.id)}
        <div class:featured={system.id === 'xln'} class="matrix-system" role="columnheader">
          <span class="system-icon"><svelte:component this={system.icon} size={17} strokeWidth={1.8} /></span>
          <span><strong>{system.name}</strong><small>{system.caption}</small></span>
        </div>
      {/each}
    </div>

    {#each rows as row (row.label)}
      <div class="matrix-row" role="row">
        <div class="matrix-criterion" role="rowheader">
          <svelte:component this={row.icon} size={15} strokeWidth={1.8} />
          <span>{row.label}</span>
        </div>
        {#each systems as system (system.id)}
          <div class:featured={system.id === 'xln'} class="matrix-cell" role="cell">
            <strong>{row.cells[system.id].lead}</strong>
            <span>{row.cells[system.id].detail}</span>
          </div>
        {/each}
      </div>
    {/each}
  </div>

  <div class="comparison-cards" aria-label="System comparison cards">
    {#each systems as system (system.id)}
      <article class:featured={system.id === 'xln'} class="system-card">
        <header>
          <span class="system-icon"><svelte:component this={system.icon} size={18} strokeWidth={1.8} /></span>
          <span><strong>{system.name}</strong><small>{system.caption}</small></span>
        </header>
        <dl>
          {#each rows as row (row.label)}
            <div>
              <dt><svelte:component this={row.icon} size={14} strokeWidth={1.8} /> {row.label}</dt>
              <dd><strong>{row.cells[system.id].lead}</strong><span>{row.cells[system.id].detail}</span></dd>
            </div>
          {/each}
        </dl>
      </article>
    {/each}
  </div>
</section>
