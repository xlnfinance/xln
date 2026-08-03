export type WalletEnvironment = 'browser' | 'capacitor' | 'electron';

export type WalletBootPhase =
  | 'cold'
  | 'detecting-environment'
  | 'initializing-native'
  | 'acquiring-tab'
  | 'inactive-tab'
  | 'loading-settings'
  | 'loading-vault'
  | 'loading-runtime'
  | 'empty'
  | 'locked'
  | 'connecting'
  | 'ready'
  | 'recoverable-error'
  | 'fatal-error'
  | 'disposed';

export type WalletBootSnapshot = Readonly<{
  phase: WalletBootPhase;
  generation: number;
  environment: WalletEnvironment | null;
  ownsActiveTab: boolean;
  activeRuntimeId: string | null;
  runtimeCount: number;
  error: string | null;
}>;

export type WalletAvailability = Readonly<{
  activeRuntimeId: string | null;
  runtimeCount: number;
  activeRuntimeUnlocked: boolean;
  runtimeReady: boolean;
}>;

export type WalletBootEvent =
  | Readonly<{ type: 'start' }>
  | Readonly<{ type: 'environment-detected'; environment: WalletEnvironment }>
  | Readonly<{ type: 'native-ready' }>
  | Readonly<{ type: 'tab-acquired' }>
  | Readonly<{ type: 'tab-inactive' }>
  | Readonly<{ type: 'settings-loaded' }>
  | Readonly<{ type: 'vault-loaded' }>
  | Readonly<{ type: 'runtime-loading' }>
  | Readonly<{ type: 'availability'; availability: WalletAvailability }>
  | Readonly<{ type: 'failure'; error: string; recoverable: boolean }>
  | Readonly<{ type: 'retry' }>
  | Readonly<{ type: 'dispose' }>;

export const initialWalletBootSnapshot = (): WalletBootSnapshot => Object.freeze({
  phase: 'cold',
  generation: 0,
  environment: null,
  ownsActiveTab: false,
  activeRuntimeId: null,
  runtimeCount: 0,
  error: null,
});

const invalidTransition = (snapshot: WalletBootSnapshot, event: WalletBootEvent): never => {
  throw new Error(`WALLET_BOOT_TRANSITION_INVALID:${snapshot.phase}->${event.type}`);
};

const availabilityPhase = (availability: WalletAvailability): WalletBootPhase => {
  if (availability.runtimeCount === 0) return 'empty';
  if (!availability.activeRuntimeId || !availability.activeRuntimeUnlocked) return 'locked';
  return availability.runtimeReady ? 'ready' : 'connecting';
};

const transitionAvailability = (
  snapshot: WalletBootSnapshot,
  availability: WalletAvailability,
): WalletBootSnapshot => Object.freeze({
  ...snapshot,
  phase: availabilityPhase(availability),
  activeRuntimeId: availability.activeRuntimeId,
  runtimeCount: availability.runtimeCount,
  error: null,
});

export const transitionWalletBoot = (
  snapshot: WalletBootSnapshot,
  event: WalletBootEvent,
): WalletBootSnapshot => {
  if (event.type === 'dispose') {
    if (snapshot.phase === 'disposed') return snapshot;
    return Object.freeze({ ...snapshot, phase: 'disposed', ownsActiveTab: false });
  }
  if (event.type === 'failure') {
    if (snapshot.phase === 'disposed') return invalidTransition(snapshot, event);
    if (!event.error.trim()) throw new Error('WALLET_BOOT_FAILURE_MESSAGE_REQUIRED');
    return Object.freeze({
      ...snapshot,
      phase: event.recoverable ? 'recoverable-error' : 'fatal-error',
      error: event.error,
    });
  }
  if (event.type === 'start' || event.type === 'retry') {
    const allowed = event.type === 'start'
      ? snapshot.phase === 'cold'
      : snapshot.phase === 'recoverable-error' || snapshot.phase === 'fatal-error';
    if (!allowed) return invalidTransition(snapshot, event);
    return Object.freeze({
      ...initialWalletBootSnapshot(),
      phase: 'detecting-environment',
      generation: snapshot.generation + 1,
    });
  }
  if (event.type === 'environment-detected') {
    if (snapshot.phase !== 'detecting-environment') return invalidTransition(snapshot, event);
    return Object.freeze({ ...snapshot, phase: 'initializing-native', environment: event.environment });
  }
  if (event.type === 'native-ready') {
    if (snapshot.phase !== 'initializing-native') return invalidTransition(snapshot, event);
    return Object.freeze({ ...snapshot, phase: 'acquiring-tab' });
  }
  if (event.type === 'tab-inactive') {
    if (snapshot.phase === 'disposed') return invalidTransition(snapshot, event);
    return Object.freeze({ ...snapshot, phase: 'inactive-tab', ownsActiveTab: false, error: null });
  }
  if (event.type === 'tab-acquired') {
    if (snapshot.phase !== 'acquiring-tab' && snapshot.phase !== 'inactive-tab') {
      return invalidTransition(snapshot, event);
    }
    return Object.freeze({ ...snapshot, phase: 'loading-settings', ownsActiveTab: true, error: null });
  }
  if (event.type === 'settings-loaded') {
    if (snapshot.phase !== 'loading-settings') return invalidTransition(snapshot, event);
    return Object.freeze({ ...snapshot, phase: 'loading-vault' });
  }
  if (event.type === 'vault-loaded') {
    if (snapshot.phase !== 'loading-vault') return invalidTransition(snapshot, event);
    return Object.freeze({ ...snapshot, phase: 'loading-runtime' });
  }
  if (event.type === 'runtime-loading') {
    if (!['empty', 'locked', 'connecting', 'ready'].includes(snapshot.phase)) {
      return invalidTransition(snapshot, event);
    }
    return Object.freeze({ ...snapshot, phase: 'loading-runtime', error: null });
  }
  if (snapshot.phase !== 'loading-runtime' && !['empty', 'locked', 'connecting', 'ready'].includes(snapshot.phase)) {
    return invalidTransition(snapshot, event);
  }
  return transitionAvailability(snapshot, event.availability);
};
