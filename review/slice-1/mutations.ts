// Run only in a disposable, clean checkout: bun mutations.ts <checkout> <report.json>.
// Each mutation must fail a behavioral assertion, not merely fail to load or typecheck.
const [root, report] = process.argv.slice(2);
if (!root || !report) throw new Error("checkout and report path required");
const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, ...args]);
if (git("status", "--porcelain").stdout.toString().trim()) throw new Error("checkout must be clean");
const chain = "entity/chain.ts";
const loop = "host/shell/watch/loop.ts";
const watch = "j/watch.ts";
const cases = [
  ["repeat epoch", chain, "e.epoch === f.epoch && against.nonce", "true && against.nonce", "entity/chain.test.ts", "repeated start fills"],
  ["repeat nonce", chain, "against.nonce === e.nonce", "true", "entity/chain.test.ts", "repeated start fills"],
  ["repeat hash", chain, "against.bodyHash.toLowerCase() === e.bodyHash.toLowerCase()", "true", "entity/chain.test.ts", "repeated start fills"],
  ["body authentication", chain, "hash.value.toLowerCase() === e.bodyHash.toLowerCase()", "true", "entity/chain.test.ts", "body the chain did not log"],
  ["right-side pruning", loop, "r.left === hosted ? r.right : r.left", "r.right", "host/shell/watch/loop.test.ts", "hosted Entity is Right"],
  ["earliest lost block", loop, "was <= block ? first", "was >= block ? first", "host/shell/watch/loop.test.ts", "earliest lost block"],
  ["own start filter", watch, "&& !hosted.includes(e.sender)", "&& true", "host/shell/watch/loop.test.ts", "start of the hosted Entity"],
  ["stranger finalize filter", watch, 'e.shown._tag !== "read" && hostsAny(hosted, e)', 'e.shown._tag !== "read" && true', "host/shell/watch/loop.test.ts", "stranger finalize asks"],
  ["partial log failure", "host/shell/evm/watch.ts", "ok([...head.value, ...tail.value]) : tail", "ok([...head.value, ...tail.value]) : head", "host/shell/evm/watch.test.ts", "failed tail discards"],
  ["two finalizes", loop, "awaited(e) || afterUnread(batch.events, awaited, hosted, e)", "awaited(e)", "host/shell/watch/loop.test.ts", "later finalize cannot"],
  ["covered WAL reads", loop, "events.filter((e) => e.block > stand.view)", "events", "host/shell/node/watch.test.ts", "WAL-covered pruned state"],
  ["pending start epoch", "j/observe.ts", "epoch: epochAt(context, e, at)", "epoch: at.epoch", "host/shell/watch/loop.test.ts", "pending start keeps its event epoch"],
  ["named-set invalidation", "entity/frame.ts", 'a._tag === "j_secret" || stable ? next : { ...next, names: undefined }', "next", "entity/paybook/paybook.test.ts", "peer lock between two reveals"],
] as const;
const results = [];
for (const [name, path, before, after, test, pattern] of cases) {
  const file = `${root}/pure/${path}`;
  const original = await Bun.file(file).text();
  if (original.split(before).length !== 2) throw new Error(`${name}: mutation must match exactly once`);
  try {
    await Bun.write(file, original.replace(before, after));
    const run = Bun.spawnSync(["bun", "test", `./${test}`, "--test-name-pattern", pattern], {
      cwd: `${root}/pure`, stdout: "pipe", stderr: "pipe",
    });
    const output = run.stdout.toString() + run.stderr.toString();
    const killed = run.exitCode !== 0 && output.includes("error: expect(received)") && output.includes("(fail)");
    results.push({ name, killed, exitCode: run.exitCode, test, pattern, output });
    console.log(`${killed ? "killed" : "NOT KILLED"}: ${name}`);
  } finally {
    await Bun.write(file, original);
  }
}
await Bun.write(report, JSON.stringify({ sha: git("rev-parse", "HEAD").stdout.toString().trim(), results }, null, 2));
process.exit(results.every((result) => result.killed) ? 0 : 1);
