;; Witness for the part-paid claim: a claim is part-paid in the bound. Adds an invariant that says it never happens; the check
;; must FAIL on it. Loaded after j/configs/debts-partial.scm.
(define j-batch
  (assoc-in j-batch (list :invariants)
            (append invariants
                    (list (property "witness: a claim is part-paid and stays at the head" (w)
                            (every (lambda (e) (not (:partial e))) (:enforcements w)))))))
