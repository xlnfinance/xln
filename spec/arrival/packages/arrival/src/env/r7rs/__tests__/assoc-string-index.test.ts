// assoc with a string key over a list built by consing: the answer is the answer of the plain walk, for every version of the list.
// The index behind it (lists.ts versionOf) is shared along the chain of versions, so the rows below are the ways it could be wrong:
// an older version asked after a newer one was built, a branch (two extensions of one list), a duplicate key, a key that is not
// a string, a non-pair entry, an empty list, and a list long enough to be walked down by the cycle check.
import { describe, expect, it } from "vitest";

import { execState, LexicalScope, toJS } from "../../../index.js";

const run = async (source: string): Promise<unknown> => {
  const { values } = await execState(source, { scope: LexicalScope.fresh("assoc-string-index") });
  return toJS(values.at(-1));
};

describe("assoc, string key, list built by consing", () => {
  it("finds the first entry, and #f for a key that is not there", async () => {
    expect(await run(`(let ((l (cons (cons "b" 2) (cons (cons "a" 1) (list))))) (list (assoc "a" l) (assoc "b" l) (assoc "c" l)))`)).toEqual([["a", 1], ["b", 2], false]);
  });

  it("an older version still answers as it did after a newer one was built", async () => {
    const answers = await run(`
      (let* ((l1 (cons (cons "a" 1) (list)))
             (l2 (cons (cons "b" 2) l1))
             (l3 (cons (cons "c" 3) l2)))
        (list (assoc "c" l3) (assoc "c" l2) (assoc "b" l2) (assoc "b" l1) (assoc "a" l1) (assoc "a" l3)))`);
    expect(answers).toEqual([["c", 3], false, ["b", 2], false, ["a", 1], ["a", 1]]);
  });

  it("two extensions of one list do not see each other's entries", async () => {
    const answers = await run(`
      (let* ((base (cons (cons "a" 1) (list)))
             (left (cons (cons "x" 10) base))
             (right (cons (cons "y" 20) base)))
        (list (assoc "x" left) (assoc "y" left) (assoc "x" right) (assoc "y" right) (assoc "a" left) (assoc "a" right)))`);
    expect(answers).toEqual([["x", 10], false, false, ["y", 20], ["a", 1], ["a", 1]]);
  });

  it("with a duplicate key the newest cons wins in the newest version and the older one in the older version", async () => {
    const answers = await run(`
      (let* ((l1 (cons (cons "k" 1) (list)))
             (l2 (cons (cons "k" 2) l1)))
        (list (assoc "k" l2) (assoc "k" l1)))`);
    expect(answers).toEqual([["k", 2], ["k", 1]]);
  });

  it("a key that is not a string makes the list answer by the plain walk", async () => {
    const answers = await run(`
      (let ((l (cons (cons "a" 1) (cons (cons 7 2) (cons (cons "b" 3) (list))))))
        (list (assoc "a" l) (assoc "b" l) (assoc 7 l) (assoc "z" l)))`);
    expect(answers).toEqual([["a", 1], ["b", 3], [7, 2], false]);
  });

  it("an entry that is not a pair is skipped, as the plain walk skips it", async () => {
    const answers = await run(`(let ((l (cons 5 (cons (cons "a" 1) (list))))) (list (assoc "a" l) (assoc "b" l)))`);
    expect(answers).toEqual([["a", 1], false]);
  });

  it("the empty list has no entry", async () => {
    expect(await run(`(assoc "a" (list))`)).toBe(false);
  });

  it("a thousand versions built one after the other, each asked about its newest and its oldest key", async () => {
    const answers = await run(`
      (let loop ((i 0) (l (list)) (bad 0))
        (if (= i 1000)
            bad
            (let ((next (cons (cons (str "key-" i) i) l)))
              (loop (+ i 1) next
                    (+ bad (if (and (equal? (assoc (str "key-" i) next) (cons (str "key-" i) i))
                                    (or (= i 0) (equal? (assoc "key-0" next) (cons "key-0" 0)))
                                    (not (assoc (str "key-" (+ i 1)) next)))
                               0 1))))))`);
    expect(answers).toBe(0);
  });

  it("a custom compare still walks the list", async () => {
    expect(await run(`(assoc "A" (list (cons "a" 1)) (lambda (x y) (string-ci=? x y)))`)).toEqual(["a", 1]);
  });
});
