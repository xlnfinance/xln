// The spec jobs behind `One gate` (Quint and Arrival) skip their work when the Actions cache holds a marker of a pass on the same files.
// That is sound only if the marker is keyed on every file the job reads, every step that does work is skipped on a hit (and only then),
// and the marker is recorded after the suite ran (the cache saves it only when the whole job passed). Checked for every job behind
// `one-gate` that runs `bash check.sh` or `node test.mjs`; the workflow is given with its comments already removed.
//   CI_SPEC_MARKER_MISSING   no cache step with id marker and path .spec-passed
//   CI_SPEC_MARKER_KEY       the key does not hash the files the suite reads (spec/** for Arrival, spec/quint/** or spec/** for Quint)
//   CI_SPEC_SHARDS           an Arrival job whose marker key leaves out matrix.shard (one shard's pass would stand for the others), or whose
//                            matrix values are not exactly 0 .. n-1 for the n of `SHARD="<matrix.shard>/n"` (a shard would never run)
//   CI_SPEC_UNGUARDED        a run step that is not guarded by cache-hit != 'true'
//   CI_SPEC_RECORD           the pass is not recorded by the last step, after the suite (itself the one line of its step)
import { gateJobs, jobBlocks, runCommands } from "./ci-steps.ts";

const GUARD = "if: steps.marker.outputs.cache-hit != 'true'";

// The steps of a job: a step starts at a list item with a key (`- name:`, `- uses:`, `- run:`).
const stepsOf = (job: string): readonly string[] => job.split(/^(?=\s*-\s+[\w-]+:)/m).slice(1);

const keyOf = (step: string): string => /^\s+key:\s*(.+)$/m.exec(step)?.[1] ?? "";

export const specProblems = (name: string, workflow: string): readonly string[] => {
  const jobs = jobBlocks(workflow);
  return gateJobs(workflow).flatMap((id) => {
    const job = jobs[id] ?? "";
    const commands = runCommands(job);
    const quint = commands.includes("bash check.sh");
    const arrival = commands.some((command) => /(?:^|\s)node test\.mjs$/.test(command));
    if (!quint && !arrival) return [];
    const steps = stepsOf(job);
    const marker = steps.find((step) => /^\s*(?:-\s+)?id:\s*marker\s*$/m.test(step) && /uses:\s*actions\/cache@/.test(step) && /path:\s*\.spec-passed\s*$/m.test(step));
    const hashed = [...keyOf(marker ?? "").matchAll(/hashFiles\('([^']*)'\)/g)].map((match) => match[1]!);
    const reads = arrival ? ["spec/**"] : ["spec/quint/**", "spec/**"];
    const work = steps.filter((step) => /^\s*(?:-\s+)?run:/m.test(step));
    const suite = steps.findIndex((step) => /\brun:\s*(?:SHARD="[^"]*" )?(?:bash check\.sh|node test\.mjs)\s*$/m.test(step));
    const last = steps[steps.length - 1] ?? "";
    const shardArg = /SHARD="\$\{\{\s*matrix\.shard\s*\}\}\/(\d+)"\s+node test\.mjs\s*$/m.exec(job)?.[1];
    const values = /^\s+shard:\s*\[([^\]]*)\]\s*$/m.exec(job)?.[1]?.split(",").map((value) => value.trim().replace(/^['"]|['"]$/g, ""));
    const exact = shardArg !== undefined && values !== undefined && values.join(",") === Array.from({ length: Number(shardArg) }, (_, k) => String(k)).join(",");
    const keyed = /\$\{\{\s*matrix\.shard\s*\}\}/.test(keyOf(marker ?? "")) && keyOf(marker ?? "").includes(`-of-${shardArg}-`);
    return [
      ...(arrival && marker !== undefined && /\bSHARD=/.test(job) && !(exact && keyed) ? [`CI_SPEC_SHARDS ${name} job ${id} must key its marker on matrix.shard and "-of-<n>-", and list the matrix shard values 0 .. n-1 for the n in SHARD="\${{ matrix.shard }}/<n>"`] : []),
      ...(marker === undefined ? [`CI_SPEC_MARKER_MISSING ${name} job ${id} runs a spec suite with no cache step (id marker, path .spec-passed) to skip it on a pass`] : []),
      ...(marker !== undefined && !hashed.some((files) => reads.includes(files)) ? [`CI_SPEC_MARKER_KEY ${name} job ${id} keys its marker on ${hashed.join(", ") || "no hashFiles"}, not on ${reads.join(" or ")}, the files the suite reads`] : []),
      ...work.filter((step) => !step.includes(GUARD)).map((step) => `CI_SPEC_UNGUARDED ${name} job ${id} has a run step without \`${GUARD}\`: ${step.trim().split("\n")[0]}`),
      ...(suite < 0 || !/echo ok > \.spec-passed\//.test(last) ? [`CI_SPEC_RECORD ${name} job ${id} does not record the pass in its last step, after the suite`] : []),
    ];
  });
};
