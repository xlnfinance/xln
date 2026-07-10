import type { DeltaCapacityBarPresentation } from '$lib/components/Entity/shared/delta-types';

export type RcpanScenarioId = 'full-collateral' | 'reserve-backed' | 'debt-recovery';
export type RcpanScenarioMode = 'auto' | RcpanScenarioId;
export type RcpanCourtPlacement = 'top' | 'bottom' | 'right';

export type RcpanMicroscopePalette = Readonly<{
  credit: string;
  collateral: string;
  debt: string;
  track: string;
  delta: string;
  proof: string;
  danger: string;
  user: string;
  hub: string;
  court: string;
}>;

export type RcpanMicroscopeControls = Readonly<{
  scenarioMode: RcpanScenarioMode;
  tokenCount: number;
  courtPlacement: RcpanCourtPlacement;
  playing: boolean;
  playbackSpeed: number;
  phaseDurationMs: number;
  barHeightPx: number;
  barLayout: 'center' | 'sides';
  nodeScale: number;
  showAmounts: boolean;
  showConservation: boolean;
  showTokenRings: boolean;
  showPaymentTrail: boolean;
  colorMode: 'theme' | 'custom';
  palette: RcpanMicroscopePalette;
  transition: boolean;
  glow: boolean;
  sweep: boolean;
  transitionMs: number;
  packetMs: number;
}>;

export const DEFAULT_MICROSCOPE_PALETTE: RcpanMicroscopePalette = {
  credit: '#d4d4d8',
  collateral: '#2dd4a3',
  debt: '#fb5f73',
  track: '#282a30',
  delta: '#ff7a7a',
  proof: '#56d99f',
  danger: '#ff5268',
  user: '#3b9cff',
  hub: '#48d597',
  court: '#e6b84f',
};

export const DEFAULT_MICROSCOPE_CONTROLS: RcpanMicroscopeControls = {
  scenarioMode: 'auto',
  tokenCount: 2,
  courtPlacement: 'top',
  playing: true,
  playbackSpeed: 1,
  phaseDurationMs: 1_550,
  barHeightPx: 8,
  barLayout: 'center',
  nodeScale: 1,
  showAmounts: true,
  showConservation: true,
  showTokenRings: true,
  showPaymentTrail: true,
  colorMode: 'theme',
  palette: DEFAULT_MICROSCOPE_PALETTE,
  transition: true,
  glow: true,
  sweep: false,
  transitionMs: 520,
  packetMs: 1_200,
};

export function cloneMicroscopeControls(): RcpanMicroscopeControls {
  return {
    ...DEFAULT_MICROSCOPE_CONTROLS,
    palette: { ...DEFAULT_MICROSCOPE_CONTROLS.palette },
  };
}

function themePalette(): RcpanMicroscopePalette {
  return {
    credit: 'color-mix(in srgb, var(--theme-text-primary, #fff) 72%, transparent)',
    collateral: 'var(--theme-bar-collateral, #2dd4a3)',
    debt: 'var(--theme-bar-debt, #fb5f73)',
    track: 'var(--theme-bar-bg, #282a30)',
    delta: 'var(--theme-debit, #ff7a7a)',
    proof: 'var(--theme-badge-synced, #56d99f)',
    danger: 'var(--theme-debit, #ff5268)',
    user: 'var(--theme-entity, #3b9cff)',
    hub: 'var(--theme-collateral, #48d597)',
    court: 'var(--theme-accent, #e6b84f)',
  };
}

export function resolveMicroscopePalette(
  controls: RcpanMicroscopeControls,
): RcpanMicroscopePalette {
  return controls.colorMode === 'theme' ? themePalette() : controls.palette;
}

export function resolveMicroscopeBarPresentation(
  controls: RcpanMicroscopeControls,
): DeltaCapacityBarPresentation {
  const palette = resolveMicroscopePalette(controls);
  return {
    colors: {
      credit: palette.credit,
      collateral: palette.collateral,
      debt: palette.debt,
      track: palette.track,
      delta: palette.delta,
    },
    animations: {
      transition: controls.transition,
      sweep: controls.sweep,
      glow: controls.glow,
      ripple: false,
    },
    durationsMs: {
      transition: controls.transitionMs,
      sweep: Math.max(300, controls.transitionMs),
      glow: controls.transitionMs,
      ripple: controls.transitionMs,
    },
    creditGradient: true,
  };
}
