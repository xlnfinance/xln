// og admission (admitEntityTransactions) signs every locally admitted tx into the replica's own Entity commands
// through prepareLocallyAuthoredEntityTxs. These helpers run og's own author and command handlers over the same
// Entity state and txs, so a test compares the rewrite's mempool, frame txs or committed state with exactly og's.
import { registerSignerKey } from "../../core/account/crypto.ts";
import {
  advanceEntityCommandNonce,
  assertSignedEntityCommand,
  getEntityCommandDisposition,
  prepareLocallyAuthoredEntityTxs,
} from "../../core/entity/command/index.ts";
import {
  handleChatEntityTx,
  handleChatMessageEntityTx,
  handleProfileUpdateEntityTx,
  handleProposeEntityTx,
  handleVoteEntityTx,
} from "../../core/entity/tx/handlers/system/basic.ts";
import { EntityCommandRejectionError } from "../../core/entity/tx/processing/invariant-errors.ts";
import { encodeCanonicalConsensusBytes } from "../../core/protocol/serialization/binary-codec.ts";
import { wireEntityTx, type EntityState, type EntityTx } from "../xln.ts";
import { ANVIL_KEYS, MORE_ANVIL_KEYS, signerAddress } from "../xln_run.ts";

/** og signs with the runtime's registered signer keys: every real key the rewrite's test crypto signs with. */
export const OG_AUTHOR_ENV = { quietRuntimeLogs: true, runtimeSeed: `0x${"a5".repeat(32)}` };
for (const key of [...ANVIL_KEYS, ...MORE_ANVIL_KEYS]) {
  registerSignerKey(OG_AUTHOR_ENV as never, signerAddress(key), Buffer.from(key.slice(2), "hex"));
}

/** The og EntityState fields command authoring reads: id, positional board, stack jurisdiction, nonces, proposals. */
export const ogCommandState = (s: EntityState, extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const q = s.quorum;
  // og config: validators are the board's signer addresses (a board quorum's bytes32 entity ids end in them)
  const members: [string, { shares: bigint }][] = q._tag === "teaching"
    ? [...q.members]
    : q.board.entityIds.map((id, i) => [`0x${id.slice(-40)}`, { shares: BigInt(q.board.votingPowers[i] ?? 0) }]);
  const threshold = q._tag === "teaching" ? q.threshold : BigInt(q.board.votingThreshold);
  const jurisdiction = s.jurisdictionConfig === undefined
    ? {}
    : { jurisdiction: { ...s.jurisdiction, entityProviderAddress: s.jurisdictionConfig.entityProviderAddress } };
  const nonces = s.committed["entityCommandNonces"];
  return {
    entityId: s.id,
    timestamp: Number(s.timestamp),
    config: {
      mode: "proposer-based",
      threshold,
      validators: members.map(([a]) => a.toLowerCase()),
      shares: Object.fromEntries(members.map(([a, m]) => [a.toLowerCase(), m.shares])),
      ...jurisdiction,
    },
    ...(nonces === undefined ? {} : { entityCommandNonces: nonces }),
    proposals: s.committed["proposals"] ?? new Map(),
    ...extra,
  };
};

/**
 * og prepareLocallyAuthoredEntityTxs over the rewrite's state and txs, in og's wire form. The author is the replica's
 * signer id, which og keeps canonical (trim + lowercase).
 */
export const ogAuthored = (
  s: EntityState,
  author: string,
  txs: readonly EntityTx[],
  extra: Record<string, unknown> = {},
  env: Record<string, unknown> = {},
): unknown[] =>
  prepareLocallyAuthoredEntityTxs(
    { ...OG_AUTHOR_ENV, ...env } as never,
    ogCommandState(s, extra) as never,
    author.trim().toLowerCase(),
    txs.map(wireEntityTx) as never,
  );

/** og's refusal message when its author throws, else `ok`. */
export const ogAuthorVerdict = (
  s: EntityState,
  author: string,
  txs: readonly EntityTx[],
  extra: Record<string, unknown> = {},
  env: Record<string, unknown> = {},
): string => {
  try {
    ogAuthored(s, author, txs, extra, env);
    return "ok";
  } catch (e) {
    return (e as Error).message;
  }
};

/** og's canonical consensus bytes, for comparing committed og-shaped collections (proposals, nonce fences). */
export const consensusBytes = (v: unknown): string => Buffer.from(encodeCanonicalConsensusBytes(v)).toString("hex");

/** The rewrite's txs in og's wire form, for a direct comparison with ogAuthored. */
export const wired = (txs: readonly EntityTx[]): unknown[] => txs.map(wireEntityTx);

type OgCommandOutcome =
  | { readonly state: any }
  | { readonly error: "entity_command" | "entity_invariant"; readonly message: string };
const refusalTag = (e: unknown): "entity_command" | "entity_invariant" =>
  e instanceof EntityCommandRejectionError ? "entity_command" : "entity_invariant";
/**
 * og applyNestedEntityTx (frame/application.ts) with og's own handlers: signed-command checks, disposition, the
 * individual txs, approved collective txs (chatMessage, profile-update), nonce advance.
 */
export const ogApplyCommand = (before: any, command: unknown, env: unknown = OG_AUTHOR_ENV): OgCommandOutcome => {
  const st = structuredClone(before);
  try {
    const c = assertSignedEntityCommand(env as never, st, command);
    if (getEntityCommandDisposition(st, c) !== "next") return { state: st };
    let cur = st;
    const collective = (tx: any): void => {
      if (tx.type === "chatMessage") cur = handleChatMessageEntityTx(cur, tx, true).newState;
      else if (tx.type === "profile-update") cur = handleProfileUpdateEntityTx(env as never, cur, tx, true).newState;
      else throw new Error(`test: collective ${tx.type}`);
    };
    for (const tx of c.txs as any[]) {
      const r = tx.type === "propose"
        ? handleProposeEntityTx(env as never, cur, tx, true)
        : tx.type === "vote"
          ? handleVoteEntityTx(env as never, cur, tx, true)
          : handleChatEntityTx(cur, tx, true);
      cur = r.newState;
      for (const approved of r.approvedEntityTxs ?? []) collective(approved);
    }
    return { state: advanceEntityCommandNonce(cur, c) };
  } catch (e) {
    return { error: refusalTag(e), message: String(e) };
  }
};

/** og's nonce fence after the given authored commands commit (their txs not executed). */
export const ogFenceAfter = (before: any, txs: readonly unknown[]): unknown =>
  txs.reduce<any>((state, tx) => advanceEntityCommandNonce(state, (tx as { data: never }).data), before)
    .entityCommandNonces;

/** og's state after each authored command in order; a refused command throws og's message. */
export const ogAfterCommands = (before: any, txs: readonly unknown[]): any =>
  txs.reduce((state: any, tx) => {
    const w = tx as { type: string; data: unknown };
    if (w.type !== "entityCommand") throw new Error(`og: not a command: ${w.type}`);
    const out = ogApplyCommand(state, w.data);
    if ("error" in out) throw new Error(out.message);
    return out.state;
  }, before);
