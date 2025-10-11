/**
 * Simple 2×2×2 Cube Demo
 *
 * Pure XLN primitives - maps directly to EntityInput structure
 */

export default async function (runtime) {
  const { process, createEmptyEnv, loadScenarioFromText } = runtime;

  // Use existing DSL parser (it already works)
  const scenario = `
SEED cube-demo

0: Genesis
A perfect cube materializes
grid 2 2 2

===

1: First Payment
Entity at (0,0,0) pays entity at (1,0,0)
0_0_0 pay 1_0_0 100000

===

2: Cross-Cube Flow
Payment travels through the cube
0_0_0 pay 1_1_1 50000
`;

  const env = createEmptyEnv();
  const parsed = await runtime.parseScenario(scenario);

  // Execute scenario - generates real EntityInput frames
  return await runtime.executeScenario(parsed, env);
}
