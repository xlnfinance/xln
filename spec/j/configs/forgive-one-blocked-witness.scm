;; Witness: the counterparty's head claim is forgiven while the entity's own head claim, owed to a third party, stays. Adds an
;; invariant that says it never happens; the check must FAIL on it. Loaded after j/configs/forgive-one-blocked.scm.
(define j-batch
  (assoc-in j-batch (list :invariants)
            (append invariants
                    (list (property "witness: a settlement lands with one direction forgiven and the other blocked" (w)
                            (null? (:forgiven w)))))))
