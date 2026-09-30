// Regenerate contracts/vectors/*.json from the deployed fork bytecode: bun contracts/scripts/write-vectors.ts
import { writeFileSync } from "node:fs";
import { allVectors } from "../test/vm/vectors.ts";

const { functions, lifecycle, baseline } = await allVectors();
const write = (name: string, value: unknown) => writeFileSync(new URL(`../vectors/${name}.json`, import.meta.url), `${JSON.stringify(value, null, 2)}\n`);
write("functions", functions);
write("lifecycle", lifecycle);
write("baseline", baseline);
process.exit(0);
