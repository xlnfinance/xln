// TS config fixture — REAL TypeScript syntax (annotation + interface), loaded by the
// built CLI via plain dynamic import (node ≥ 22.18 type-strips natively).
interface FixtureArrivalConfig {
  capabilities: { module: string; config?: Record<string, unknown> }[];
}

const config: FixtureArrivalConfig = {
  capabilities: [{ module: "../caps/config-greet.mjs", config: { greeting: "from-ts-config" } }],
};

export default config;
