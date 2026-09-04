import type { RuntimeReplica } from '../runtime/types';
import { SCENARIOS } from './runner/catalog';

export {
  SCENARIOS,
  getScenario,
  getScenariosByTag,
  type ScenarioMetadata,
} from './runner/catalog';

export type ScenarioEntry = {
  key: string;
  name: string;
  load: () => Promise<(env: RuntimeReplica) => Promise<void | RuntimeReplica>>;
  requiresStress?: boolean;
};

export const scenarioRegistry: ScenarioEntry[] = SCENARIOS.map((scenario) => ({
  key: scenario.id,
  name: scenario.name,
  load: async () => scenario.run,
  ...(scenario.requiresStress === true ? { requiresStress: true } : {}),
}));
