export type AppMode = 'user' | 'dev';
export type ViewMode = 'home' | 'settings' | 'docs' | 'brainvault' | 'panels' | 'graph3d' | 'terminal';

export interface NavigationSelection {
  runtime: string | null;
  jurisdiction: string | null;
  signer: string | null;
  entity: string | null;
  account: string | null;
}

export interface AppState {
  mode: AppMode;
  landingVisible: boolean;
  viewMode: ViewMode;
  requestedDockPanel: string | null;
  navigation: NavigationSelection;
}

export type AppStateInput =
  | Readonly<{ type: 'toggleMode' }>
  | Readonly<{ type: 'setMode'; mode: AppMode }>
  | Readonly<{ type: 'openDockPanel'; panelId: string }>
  | Readonly<{ type: 'clearDockPanelRequest'; panelId: string }>
  | Readonly<{ type: 'setLandingVisible'; visible: boolean }>
  | Readonly<{ type: 'setViewMode'; mode: ViewMode }>
  | Readonly<{ type: 'navigate'; level: keyof NavigationSelection; id: string | null }>
  | Readonly<{ type: 'resetNavigation' }>;

const navigationHierarchy: readonly (keyof NavigationSelection)[] = [
  'runtime',
  'jurisdiction',
  'signer',
  'entity',
  'account',
];

export const defaultNavigation = (): NavigationSelection => ({
  runtime: 'local',
  jurisdiction: null,
  signer: null,
  entity: null,
  account: null,
});

export const defaultAppState = (): AppState => ({
  mode: 'user',
  landingVisible: true,
  viewMode: 'home',
  requestedDockPanel: null,
  navigation: defaultNavigation(),
});

const navigate = (
  state: AppState,
  level: keyof NavigationSelection,
  id: string | null,
): AppState => {
  const navigation = { ...state.navigation, [level]: id };
  const levelIndex = navigationHierarchy.indexOf(level);
  for (const downstream of navigationHierarchy.slice(levelIndex + 1)) navigation[downstream] = null;
  return { ...state, navigation };
};

export const reduceAppState = (state: AppState, input: AppStateInput): AppState => {
  switch (input.type) {
    case 'toggleMode':
      return { ...state, mode: state.mode === 'user' ? 'dev' : 'user' };
    case 'setMode':
      return state.mode === input.mode ? state : { ...state, mode: input.mode };
    case 'openDockPanel':
      return { ...state, mode: 'dev', requestedDockPanel: input.panelId };
    case 'clearDockPanelRequest':
      return state.requestedDockPanel === input.panelId ? { ...state, requestedDockPanel: null } : state;
    case 'setLandingVisible':
      return state.landingVisible === input.visible ? state : { ...state, landingVisible: input.visible };
    case 'setViewMode':
      return state.viewMode === input.mode ? state : { ...state, viewMode: input.mode };
    case 'navigate':
      return navigate(state, input.level, input.id);
    case 'resetNavigation':
      return { ...state, navigation: defaultNavigation() };
  }
};

const viewModes: readonly ViewMode[] = [
  'home',
  'settings',
  'docs',
  'brainvault',
  'panels',
  'graph3d',
  'terminal',
];

export const appStateFromPersistence = (
  savedMode: string | null,
  savedViewMode: string | null,
): AppState => ({
  ...defaultAppState(),
  mode: savedMode === 'dev' ? 'dev' : 'user',
  viewMode: viewModes.includes(savedViewMode as ViewMode) ? savedViewMode as ViewMode : 'home',
});
