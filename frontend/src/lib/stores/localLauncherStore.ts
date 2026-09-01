import { writable } from 'svelte/store';

export type LocalLauncherOnboardingStage = 'create' | 'formation' | null;

export type LocalLauncherOnboarding = Readonly<{
  stage: LocalLauncherOnboardingStage;
  entityId: string;
}>;

const emptyLocalLauncherOnboarding = (): LocalLauncherOnboarding => ({
  stage: null,
  entityId: '',
});

export const localLauncherOnboarding = writable<LocalLauncherOnboarding>(
  emptyLocalLauncherOnboarding(),
);

export const setLocalLauncherOnboarding = (
  stage: LocalLauncherOnboardingStage,
  entityId = '',
): void => {
  localLauncherOnboarding.set({
    stage,
    entityId: String(entityId || '').trim().toLowerCase(),
  });
};

export const clearLocalLauncherOnboarding = (): void => {
  localLauncherOnboarding.set(emptyLocalLauncherOnboarding());
};
