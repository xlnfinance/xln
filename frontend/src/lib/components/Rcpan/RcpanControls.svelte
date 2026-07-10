<script lang="ts">
  import { Gauge, Palette, Pause, Play, RotateCcw, SlidersHorizontal } from 'lucide-svelte';
  import { settings, settingsOperations } from '$lib/stores/settingsStore';
  import { getAvailableThemes } from '$lib/utils/themes';
  import type { ThemeName } from '$lib/types/ui';
  import type { RcpanTimelineState } from './microscope-timeline';
  import type { RcpanMicroscopeControls, RcpanMicroscopePalette } from './microscope-playground';
  import './rcpan-controls.css';

  export let value: RcpanMicroscopeControls;
  export let timeline: RcpanTimelineState;
  export let onChange: (next: RcpanMicroscopeControls) => void;
  export let onRestart: () => void;

  const themes = getAvailableThemes();
  const paletteFields: readonly { key: keyof RcpanMicroscopePalette; label: string }[] = [
    { key: 'credit', label: 'Credit' }, { key: 'collateral', label: 'Collateral' },
    { key: 'debt', label: 'Debt' }, { key: 'track', label: 'Track' },
    { key: 'delta', label: 'Delta' }, { key: 'proof', label: 'Proof' },
    { key: 'danger', label: 'Danger' }, { key: 'user', label: 'User' },
    { key: 'hub', label: 'Hub' }, { key: 'court', label: 'Court' },
  ];

  function patch(next: Partial<RcpanMicroscopeControls>): void {
    onChange({ ...value, ...next });
  }

  function numberValue(event: Event): number {
    return Number((event.currentTarget as HTMLInputElement).value);
  }

  function stringValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement | HTMLSelectElement).value;
  }

  function checked(event: Event): boolean {
    return (event.currentTarget as HTMLInputElement).checked;
  }

  function updateTheme(event: Event): void {
    settingsOperations.setTheme(stringValue(event) as ThemeName);
  }

  function updateColor(key: keyof RcpanMicroscopePalette, event: Event): void {
    patch({ palette: { ...value.palette, [key]: stringValue(event) }, colorMode: 'custom' });
  }
</script>

<section class="rcpan-lab" id="rcpan-lab" aria-labelledby="rcpan-lab-title" data-testid="rcpan-controls">
  <header class="lab-heading">
    <div><span><SlidersHorizontal size={13} /> Visualization playground</span><h2 id="rcpan-lab-title">Tune the microscope.</h2><p>Try timing, placement, bars, reserve sizing, themes, and colors without changing account semantics.</p></div>
    <div class="lab-transport">
      <span><i></i>{timeline.phase.replaceAll('-', ' ')} · {timeline.scenario.shortLabel}</span>
      <button type="button" on:click={() => patch({ playing: !value.playing })}>{#if value.playing}<Pause size={14} /> Pause{:else}<Play size={14} /> Play{/if}</button>
      <button type="button" on:click={onRestart}><RotateCcw size={14} /> Restart</button>
    </div>
  </header>

  <div class="lab-sections">
    <details open>
      <summary><Gauge size={15} /><span>Scene & timing</span><small>content, court, speed</small></summary>
      <div class="control-grid">
        <label><span>Theme</span><select value={$settings.theme} on:change={updateTheme}>{#each themes as theme}<option value={theme.id}>{theme.name}</option>{/each}</select></label>
        <label><span>Scenario</span><select value={value.scenarioMode} on:change={(event) => patch({ scenarioMode: stringValue(event) as RcpanMicroscopeControls['scenarioMode'] })}><option value="auto">Auto tour</option><option value="full-collateral">100% collateral</option><option value="reserve-backed">70 / 30</option><option value="debt-recovery">30 / reserve / debt</option></select></label>
        <label><span>Tokens</span><select value={String(value.tokenCount)} on:change={(event) => patch({ tokenCount: numberValue(event) })}><option value="1">1 · USDC</option><option value="2">2 · USDC + WETH</option><option value="3">3 · + USDT</option><option value="4">4 · + TRX</option></select></label>
        <label><span>Court position</span><select value={value.courtPlacement} on:change={(event) => patch({ courtPlacement: stringValue(event) as RcpanMicroscopeControls['courtPlacement'] })}><option value="top">Above network</option><option value="bottom">Below network</option><option value="right">Right of network</option></select></label>
        <label class="range"><span>Phase duration <output>{(value.phaseDurationMs / 1000).toFixed(2)}s</output></span><input type="range" min="700" max="3500" step="50" value={value.phaseDurationMs} on:input={(event) => patch({ phaseDurationMs: numberValue(event) })} /></label>
        <label class="range"><span>Playback <output>{value.playbackSpeed.toFixed(2)}×</output></span><input type="range" min="0.25" max="3" step="0.25" value={value.playbackSpeed} on:input={(event) => patch({ playbackSpeed: numberValue(event) })} /></label>
        <label class="range"><span>Payment packet <output>{value.packetMs}ms</output></span><input type="range" min="300" max="2200" step="50" value={value.packetMs} on:input={(event) => patch({ packetMs: numberValue(event) })} /></label>
        <label class="range"><span>Transitions <output>{value.transitionMs}ms</output></span><input type="range" min="0" max="1400" step="50" value={value.transitionMs} on:input={(event) => patch({ transitionMs: numberValue(event) })} /></label>
      </div>
    </details>

    <details open>
      <summary><SlidersHorizontal size={15} /><span>Graph & account bars</span><small>size, layout, visibility</small></summary>
      <div class="control-grid">
        <label><span>Bar layout</span><select value={value.barLayout} on:change={(event) => patch({ barLayout: stringValue(event) as RcpanMicroscopeControls['barLayout'] })}><option value="center">Centered Δ</option><option value="sides">Separated sides</option></select></label>
        <label class="range"><span>Bar height <output>{value.barHeightPx}px</output></span><input type="range" min="4" max="16" step="1" value={value.barHeightPx} on:input={(event) => patch({ barHeightPx: numberValue(event) })} /></label>
        <label class="range"><span>Node scale <output>{value.nodeScale.toFixed(2)}×</output></span><input type="range" min="0.7" max="1.5" step="0.05" value={value.nodeScale} on:input={(event) => patch({ nodeScale: numberValue(event) })} /></label>
        <div class="toggle-grid wide">
          <label><input type="checkbox" checked={value.showAmounts} on:change={(event) => patch({ showAmounts: checked(event) })} />Amounts</label>
          <label><input type="checkbox" checked={value.showTokenRings} on:change={(event) => patch({ showTokenRings: checked(event) })} />Token reserves</label>
          <label><input type="checkbox" checked={value.showConservation} on:change={(event) => patch({ showConservation: checked(event) })} />Reserve captions</label>
          <label><input type="checkbox" checked={value.showPaymentTrail} on:change={(event) => patch({ showPaymentTrail: checked(event) })} />Payment packets</label>
          <label><input type="checkbox" checked={value.transition} on:change={(event) => patch({ transition: checked(event) })} />Bar transition</label>
          <label><input type="checkbox" checked={value.glow} on:change={(event) => patch({ glow: checked(event) })} />Bar glow</label>
          <label><input type="checkbox" checked={value.sweep} on:change={(event) => patch({ sweep: checked(event) })} />Bar sweep</label>
        </div>
      </div>
    </details>

    <details>
      <summary><Palette size={15} /><span>Color system</span><small>theme defaults or custom</small></summary>
      <div class="color-mode"><button class:active={value.colorMode === 'theme'} type="button" on:click={() => patch({ colorMode: 'theme' })}>Use theme</button><button class:active={value.colorMode === 'custom'} type="button" on:click={() => patch({ colorMode: 'custom' })}>Custom palette</button></div>
      <div class="palette-grid">{#each paletteFields as field}<label><input type="color" value={value.palette[field.key]} on:input={(event) => updateColor(field.key, event)} /><span>{field.label}</span><code>{value.palette[field.key]}</code></label>{/each}</div>
    </details>
  </div>
</section>
