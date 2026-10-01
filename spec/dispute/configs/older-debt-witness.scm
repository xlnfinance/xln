;; Witness: a shortfall meets an older debt of its debtor. Adds an invariant that says it never happens; the check must FAIL on
;; it. Loaded after dispute/configs/older-debt.scm.
(define dispute
  (assoc-in dispute (list :invariants)
            (append invariants
                    (list (property "witness: a shortfall finds an older debt" (w)
                            (every (lambda (s) (= (:older s) 0)) (:shortfalls w)))))))
