<script lang="ts">
  import RcpanAccountMicroscope from './RcpanAccountMicroscope.svelte';
  import RcpanCourtLedger from './RcpanCourtLedger.svelte';
  import type {
    MicroscopeAccountDisplay,
    MicroscopeCourtDisplay,
    MicroscopeCourtPlacement,
  } from './microscope-visual-types';
  import './rcpan-dispute-microscope.css';

  export let account: MicroscopeAccountDisplay;
  export let court: MicroscopeCourtDisplay;
  export let courtPlacement: MicroscopeCourtPlacement = 'top';
</script>

<div
  class="dispute-microscope placement-{courtPlacement}"
  data-court-placement={courtPlacement}
  data-testid="rcpan-dispute-microscope"
>
  {#if courtPlacement === 'top'}
    <div class="court-slot"><RcpanCourtLedger display={court} placement={courtPlacement} /></div>
    <div class="account-slot"><RcpanAccountMicroscope display={account} /></div>
  {:else if courtPlacement === 'bottom'}
    <div class="account-slot"><RcpanAccountMicroscope display={account} /></div>
    <div class="court-slot"><RcpanCourtLedger display={court} placement={courtPlacement} /></div>
  {:else}
    <div class="account-slot"><RcpanAccountMicroscope display={account} /></div>
    <div class="court-slot"><RcpanCourtLedger display={court} placement={courtPlacement} /></div>
  {/if}
</div>
