;; Witness: a message is refused as "forged" in some run. Adds an invariant that says it never happens; the check must FAIL on
;; it, with the trace that reaches the refusal. It shows the refusal path is reachable, so its properties are not vacuous.
(define transport
  (assoc-in transport (list :invariants)
            (append invariants
                    (list (property "witness T-forged: a message is refused as forged" (w)
                            (not (member "forged" (:refusals w))))))))
