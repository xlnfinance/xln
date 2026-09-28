// Diagnostics for diff/scenario.test.ts, printed only under SCN_TRACE: what went into a frame, what each side routed
// out of it, and where the Account views part. None of it takes part in a comparison.
import { committedView, type EntityReplica, type RoutedEntityInput } from "../xln.ts";
import { unwrap } from "../xln_run.ts";

export const tracing = (): boolean => process.env["SCN_TRACE"] !== undefined;

/** `8d47:txs[accountInput,extendCredit]  476b:jPrefixAttestations` */
export const inputsLine = (inputs: readonly RoutedEntityInput[]): string =>
  inputs
    .map((i) => {
      const kind = i.input.kind === "txs" ? `txs[${i.input.txs.map(txLine).join(",")}]` : i.input.kind;
      return `${i.entityId.slice(-4)}:${kind}`;
    })
    .join("  ");
/** An Entity tx by type, an accountInput with its sender and what it carries. */
const txLine = (t: { readonly type: string; readonly data?: unknown }): string => {
  if (t.type !== "accountInput") return t.type;
  const d = t.data as { fromEntityId: string; kind: string; frame?: { height: bigint }; height?: bigint };
  const at = d.frame?.height ?? d.height;
  return `accountInput(${d.fromEntityId.slice(-4)} ${d.kind}${at === undefined ? "" : `@${at}`})`;
};

type WireTx = {
  readonly type: string;
  readonly data?: {
    readonly fromEntityId?: string;
    readonly proposal?: { readonly frame?: { readonly height?: number; readonly accountTxs?: { type: string }[] } };
    readonly ack?: { readonly height?: number };
  };
};
type Routed = { readonly entityId: string; readonly signerId?: string; readonly entityTxs?: readonly unknown[] };
const wireTxLine = (t: unknown): string => {
  const { type, data } = t as WireTx;
  const frame = data?.proposal?.frame;
  const proposal = frame === undefined ? "" : ` prop=${frame.height}:${frame.accountTxs?.map((a) => a.type).join("+")}`;
  const ack = data?.ack === undefined ? "" : ` ack=${data.ack.height}`;
  return `${type}(from ${data?.fromEntityId?.slice(-4) ?? "-"}${proposal}${ack})`;
};
/** `8d47<-79c8:accountInput(from 476b prop=2:j_event_claim ack=1) | …` */
export const routedLine = (xs: readonly unknown[]): string =>
  (xs as readonly Routed[])
    .map((x) => `${x.entityId.slice(-4)}<-${(x.signerId ?? "").slice(-4)}:${(x.entityTxs ?? []).map(wireTxLine).join(",")}`)
    .join(" | ");

type OgAccount = Record<string, unknown> & {
  readonly currentFrame?: { readonly height?: number; readonly accountTxs?: readonly { type: string }[] };
  readonly pendingFrame?: { readonly height?: number; readonly accountTxs?: readonly { type: string }[] };
  readonly mempool?: readonly { type: string }[];
};
const types = (txs: readonly { type: string }[] | undefined): string => (txs ?? []).map((t) => t.type).join(",");
/**
 * Each Account whose og state differs from the rewrite's committed view, with both sides' frame positions (og
 * current/pending frames, the rewrite's head and candidate).
 */
export const accountLines = (
  og: ReadonlyMap<string, OgAccount>,
  mine: EntityReplica | undefined,
  name: (id: string) => string,
  self: string,
  diffs: (og: unknown, rw: unknown) => readonly string[],
): readonly string[] =>
  [...og].flatMap(([peer, acct]) => {
    const child = mine?.accountReplicas.get(peer as never);
    if (child === undefined) return [];
    const view = unwrap(committedView(child.state)) as unknown as Record<string, unknown>;
    const source = (acct["state"] ?? acct) as Record<string, unknown>;
    const shared = Object.fromEntries(Object.keys(view).map((k) => [k, source[k]]));
    // og's persistent maps carry their storage namespace, which no committed view models
    const found = diffs(shared, view).filter((d) => !d.includes(".namespace:"));
    if (found.length === 0) return [];
    const who = `${self}->${name(peer)}`;
    const cand = (child as { candidate?: { frame: { height: bigint; txs: readonly { type: string }[] } } }).candidate;
    const { currentFrame: cur, pendingFrame: pend } = acct;
    return [
      `ACCT ${who} ${found.join(" || ").slice(0, 4000)}`,
      `  og ${who} current=${cur?.height}:${types(cur?.accountTxs)} pending=${pend?.height}:${types(pend?.accountTxs)}` +
        ` mempool=${types(acct.mempool)}`,
      `  rw ${who} ${child._tag} head=${child.head.height} cand=${cand?.frame.height}:${types(cand?.frame.txs)}` +
        ` mempool=${types((child as { mempool?: readonly { type: string }[] }).mempool)}`,
    ];
  });
