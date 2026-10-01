;; Witness for the gas split: a money-only batch is starved and emits BatchGasStarved. Adds an invariant that says it never
;; happens; the check must FAIL on it. Loaded after j/configs/gas-kinds.scm.
(define j-batch
  (assoc-in j-batch (list :invariants)
            (append invariants
                    (list (property "witness: a starved money-only batch emits BatchGasStarved" (w)
                            (every (lambda (r) (not (:evented r))) (:failures w)))))))
