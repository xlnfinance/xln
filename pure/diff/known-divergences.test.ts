import { describe, expect, test } from "bun:test";
// The registered og divergences mask only the frame-hash paths that follow from their cause, and read their cause off
// og's own frame events. Anything else in a diff, above all a state root, is never masked.
import { KNOWN_DIVERGENCES } from "./departures.ts";

const [warning] = KNOWN_DIVERGENCES;

describe("known divergence: LEFT-WINS warning count", () => {
  test("its cause is og's pending-count warning and nothing else", () => {
    expect(warning!.causedBy({ message: "⚠️ LEFT has 1 pending txs while waiting for RIGHT's ACK" })).toBe(true);
    expect(warning!.causedBy({ message: "📤 LEFT-WINS: Ignored RIGHT's frame 6 (waiting for their ACK)" })).toBe(false);
    expect(warning!.causedBy({ message: "⚠️ LEFT has some pending txs while waiting for RIGHT's ACK" })).toBe(false);
    expect(warning!.causedBy({})).toBe(false);
  });
  test("it masks the frame hash and what commits to it", () => {
    [
      "meta[1].certifiedFrameHeadDigest",
      "meta[1].entityHead.frameHash",
      "head[H].frameHash",
      "head[H].parentFrameHash",
      "head[H].hankos.0",
      "head[H].hashesToSign.0.hash",
      "postStateHash.",
    ].forEach((path) => expect(warning!.follows(path)).toBe(true));
  });
  test("it never masks state, roots, components, queues or the frame's txs", () => {
    [
      "head[H].stateRoot",
      "head[H].authorityRoot",
      "head[H].leader",
      "head[H].postAuthority.x",
      "entityHashes.5.hash",
      "components.x",
      "height.",
      "timestamp.",
      "meta[1].entityHead.height",
      "routed.0",
      "queued.0",
    ].forEach((path) => expect(warning!.follows(path)).toBe(false));
  });
});
