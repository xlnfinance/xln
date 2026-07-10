<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { ArrowRight, BadgeCheck, Play, Scale } from 'lucide-svelte';
  import './rcpan-sales-hero.css';

  const dispatch = createEventDispatcher<{
    payment: void;
    dispute: void;
  }>();
</script>

<section class="sales-hero" aria-labelledby="rcpan-sales-title">
  <div class="sales-hero-inner">
    <span class="sales-hero-kicker"><BadgeCheck size={15} strokeWidth={2} /> Signed by both sides</span>

    <h1 id="rcpan-sales-title">A balance<br /><span>you can take to court.</span></h1>

    <p class="sales-hero-summary">
      In a traditional account, the operator's database says what you own. In xln, you and the
      counterparty sign the balance together. If cooperation stops, that signed account can settle
      through an EVM court.
    </p>

    <div class="sales-hero-actions" aria-label="Try the xln account flow">
      <button class="sales-action primary" type="button" on:click={() => dispatch('payment')}>
        <Play size={16} fill="currentColor" strokeWidth={1.8} />
        Run a payment
        <ArrowRight class="action-arrow" size={15} strokeWidth={2} />
      </button>
      <button class="sales-action secondary" type="button" on:click={() => dispatch('dispute')}>
        <Scale size={16} strokeWidth={1.9} />
        Start a dispute
      </button>
    </div>
  </div>
</section>
