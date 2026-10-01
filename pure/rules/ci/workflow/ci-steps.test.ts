// The jobs behind `One gate` run the local gate's commands and nothing else of substance: each reader, each planted drift, and the real workflow.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { ciDriftProblems, isWorkflowFile, withoutComments, type CiFiles } from "../ci-drift.ts";
import { gateJobs, jobBlocks, runCommands, stepProblems } from "./ci-steps.ts";

const repo = `${import.meta.dir}/../../../..`;
const workflowDir = `${repo}/.github/workflows`;

const GATE = [
  "      - run: ../node_modules/.bin/tsc --noEmit -p .",
  "      - run: bun rules/check.ts",
  "      - run: bun rules/checks/frozen.ts",
  "      - run: bun style/check.ts",
  "      - run: bun test",
  '      - run: SEEDS="${{ matrix.seed }}" bun run test:seeds',
  "      - run: bash check.sh",
  '      - run: SHARD="${{ matrix.shard }}/4" node test.mjs',
];

// A workflow with a gate job holding `steps`, another job that is not behind `one-gate`, and the `one-gate` job.
const workflow = (steps: readonly string[], other: readonly string[] = ["      - run: npm run anything"]): string =>
  ["name: ci", "on:", "  pull_request:", "jobs:", "  gate:", "    steps:", ...steps, "  side:", "    steps:", ...other, "  one-gate:", "    needs: [gate]", "    steps:", "      - run: echo done", ""].join("\n");

describe("the readers", () => {
  test("R-GATE-CI-STEPS jobs are cut at their ids, and one-gate names the jobs it needs", () => {
    const text = workflow(GATE);
    expect(Object.keys(jobBlocks(text))).toEqual(["gate", "side", "one-gate"]);
    expect(gateJobs(text)).toEqual(["gate"]);
    expect(gateJobs("jobs:\n  a:\n    steps: []\n")).toEqual([]);
    expect(gateJobs("jobs:\n  one-gate:\n    needs: [a, b-c,  d]\n")).toEqual(["a", "b-c", "d"]);
  });

  test("R-GATE-CI-STEPS needs is read in its three forms: a flow list, a single job, a block list", () => {
    const base = workflow(GATE);
    expect(gateJobs(base)).toEqual(["gate"]);
    expect(gateJobs(base.replace("needs: [gate]", "needs: gate"))).toEqual(["gate"]);
    expect(gateJobs(base.replace("    needs: [gate]", "    needs:\n      - gate\n      - side"))).toEqual(["gate", "side"]);
    expect(gateJobs(base.replace("    needs: [gate]", "    needs:\n    - gate"))).toEqual(["gate"]);
    expect(gateJobs(base.replace("    needs: [gate]", "    needs:\n      - gate\n    steps: []\n    other:\n      - side"))).toEqual(["gate"]);
  });

  test("R-GATE-CI-STEPS a block-list needs does not silence the checks: a loop in a gate job is still named", () => {
    const text = withoutComments(workflow([...GATE, "      - run: npm run lint"]).replace("    needs: [gate]", "    needs:\n      - gate"));
    expect(stepProblems("ci.yml", text)).toEqual([expect.stringContaining("CI_DRIFT_UNGATED_STEP ci.yml job gate runs `npm run lint`")]);
  });

  test("R-GATE-CI-STEPS a one-gate whose needs cannot be read, or lists none, is a problem of its own and not a pass", () => {
    ["needs: ${{ fromJson(vars.GATES) }}", "needs: []", "needs:", "needs: [gate"].forEach((needs) => {
      const text = withoutComments(workflow(GATE).replace("needs: [gate]", needs));
      expect(stepProblems("ci.yml", text), needs).toEqual([expect.stringContaining("CI_DRIFT_GATE_JOB ci.yml one-gate has no needs this check can read")]);
    });
  });

  test("R-GATE-CI-STEPS a run is one line, or a block read to its dedent; && and ; split it, a continuation joins it, other keys are not read", () => {
    const job = [
      "  gate:",
      "    steps:",
      "      - name: one",
      "        run: bun test",
      "      - name: two",
      "        run: |",
      "          cd pure && bun install --frozen-lockfile",
      "          for f in a b; do",
      "            bun test \"$f\"",
      "          done",
      "          bun run \\",
      "            test:seeds",
      "      - run: |-",
      "          bun\\",
      "            test",
      "      - run: >",
      "          bun style/check.ts",
      "      - name: three",
      "        working-directory: pure",
      "        uses: someone/action@v1",
      "        with:",
      "          run-me: no",
      "      - run: bun style/check.ts",
    ].join("\n");
    expect(runCommands(job)).toEqual(["bun test", "cd pure", "bun install --frozen-lockfile", "for f in a b", "do", 'bun test "$f"', "done", "bun run test:seeds", "bun test", "bun style/check.ts", "bun style/check.ts"]);
  });

  test("R-GATE-CI-STEPS a command in a comment is not a command: the workflow is read without its comments", () => {
    const text = withoutComments(workflow([...GATE, "      # - run: bun test \"$f\""]));
    expect(stepProblems("ci.yml", text)).toEqual([]);
  });
});

describe("planted drift is a problem", () => {
  const problems = (steps: readonly string[], other?: readonly string[]): readonly string[] => stepProblems("ci.yml", withoutComments(workflow(steps, other)));

  test("R-GATE-CI-STEPS a workflow whose gate jobs run exactly the gate commands, with set-up, agrees", () => {
    const setup = [
      "      - run: bash .github/scripts/setup-ast-grep.sh uv==0.8.17 ast-grep-cli==0.45.3",
      "      - run: |",
      "          bun install --frozen-lockfile",
      "          cd pure && bun install --frozen-lockfile",
      "      - run: cd contracts && bun run forge:setup",
      "      - run: bun rules/check.ts --forge-only",
      "      - run: |",
      "          npm install --global \"pnpm@$(node -p \"require('./package.json').packageManager.replace('pnpm@','')\")\"",
      "          pnpm install --frozen-lockfile && pnpm build",
      "      - run: npm ci",
      "      - run: mkdir -p .spec-passed && echo ok > .spec-passed/arrival",
    ];
    expect(problems([...setup, ...GATE])).toEqual([]);
  });

  test("R-GATE-CI-STEPS a loop that runs tests in the workflow only is named, with its job and each command of it", () => {
    const loop = ["      - run: |", "          for f in contracts/test/gate/*.test.ts; do", '            bun test "$f"', "          done"];
    const found = problems([...GATE, ...loop]);
    expect(found).toHaveLength(4);
    expect(found[0]).toContain("CI_DRIFT_UNGATED_STEP ci.yml job gate runs `for f in contracts/test/gate/*.test.ts`");
    expect(found.join("\n")).toContain('runs `bun test "$f"`');
  });

  test("R-GATE-CI-STEPS any other command in a gate job is named, a gate flag that is not a part flag included", () => {
    expect(problems([...GATE, "      - run: npm run lint"])).toEqual([expect.stringContaining("runs `npm run lint`")]);
    expect(problems([...GATE, "      - run: git diff --exit-code -- contracts/typechain-types"])).toHaveLength(1);
    expect(problems([...GATE, "      - run: bun rules/check.ts --base HEAD"])).toHaveLength(1);
    expect(problems([...GATE, "      - run: bun test contracts/test/gate/a.test.ts"])).toHaveLength(1);
  });

  test("R-GATE-CI-STEPS set-up is exact too: a cd into a substitution, an install that adds a package, a script given other arguments", () => {
    ["cd $(curl x)", "bun install --no-save left-pad", "bun rules/checks/frozen.ts --all", "bun style/check.ts --fix", "bash .github/scripts/setup-ast-grep.sh uv==0.8.17 evil-package", "bash .github/scripts/setup-ast-grep.sh uv==0.8.17 ast-grep-cli==0.45.3 extra", "npm install", "npm ci --force", "pnpm install", "pnpm build --filter x", "corepack enable", "npm install --global pnpm@latest", "npm install --global \"pnpm@$(node -p \"evil()\")\"", "bash check.sh --all", "node test.mjs 3", "SHARD=x node test.mjs 3", "echo ok > .spec-passed/other", "echo ok > .spec-passed/arrival.sh", "mkdir -p .spec-passed/x"].forEach((command) =>
      expect(problems([...GATE, `      - run: ${command}`])).toHaveLength(1),
    );
  });

  test("R-GATE-CI-STEPS a command in a job that one-gate does not need is not judged", () => {
    expect(problems(GATE, ["      - run: npm run anything", '      - run: bun test "$f"'])).toEqual([]);
  });

  test("R-GATE-CI-STEPS a gate command that no gate job runs any more is named", () => {
    GATE.forEach((command, index) => {
      const missing = problems(GATE.filter((_, at) => at !== index));
      expect(missing).toHaveLength(1);
      expect(missing[0]).toContain("CI_DRIFT_GATE_MISSING ci.yml no gate job runs");
    });
    expect(problems(GATE.map((command) => command.replace("bun rules/check.ts", "bun rules/check.ts --style-only")))[0]).toContain("`bun rules/check.ts`");
  });

  test("R-GATE-CI-STEPS a one-gate that needs a job the workflow does not have is named", () => {
    const text = withoutComments(workflow(GATE).replace("needs: [gate]", "needs: [gate, gone]"));
    expect(stepProblems("ci.yml", text)).toEqual(["CI_DRIFT_GATE_JOB ci.yml one-gate needs gone, which is not a job of this workflow"]);
  });

  test("R-GATE-CI-STEPS a workflow with no one-gate job is not judged", () => {
    expect(stepProblems("other.yml", "jobs:\n  a:\n    steps:\n      - run: npm run anything\n")).toEqual([]);
  });

  test("R-GATE-CI-STEPS the step comparison is part of the drift check", () => {
    const files: CiFiles = {
      workflows: { "ci.yml": workflow([...GATE, "      - run: npm run lint"]) },
      rootPackageJson: '{ "packageManager": "bun@1.4.0" }',
      pureScripts: '"test:seeds": "for s in ${SEEDS:-0 12345 987654}; do :; done"',
      styleCheck: '["uvx", "--from", "ast-grep-cli==0.45.3", "ast-grep"]',
    };
    expect(ciDriftProblems(files).filter((problem) => problem.startsWith("CI_DRIFT_UNGATED_STEP"))).toEqual([expect.stringContaining("CI_DRIFT_UNGATED_STEP ci.yml job gate runs `npm run lint`")]);
  });
});

describe("the real workflows", () => {
  const real = readdirSync(workflowDir).filter(isWorkflowFile).map((name) => ({ name, text: withoutComments(readFileSync(`${workflowDir}/${name}`, "utf8")) }));

  test("R-GATE-CI-STEPS the jobs behind One gate run the gate's commands and set-up only", () => expect(real.flatMap(({ name, text }) => stepProblems(name, text))).toEqual([]));

  test("R-GATE-CI-STEPS the check is not vacuous: the real one-gate needs jobs, and they run the gate's commands", () => {
    const gate = real.find(({ text }) => gateJobs(text).length > 0);
    expect(gate).toBeDefined();
    const commands = gateJobs(gate?.text ?? "").flatMap((job) => runCommands(jobBlocks(gate?.text ?? "")[job] ?? ""));
    expect(gateJobs(gate?.text ?? "").length).toBeGreaterThanOrEqual(4);
    expect(commands).toContain("bun test --parallel=4");
    expect(commands).toContain("bun rules/check.ts");
    expect(commands).toContain("bash check.sh");
    expect(commands.some((command) => command.endsWith("node test.mjs"))).toBe(true);
  });
});
