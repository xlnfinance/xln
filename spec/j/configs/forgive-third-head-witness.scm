;; Witness: a settlement reverts whole on a third party's head claim. Adds an invariant that says no batch ever fails on
;; forgiveness; the check must FAIL on it. Loaded after j/configs/forgive-third-head.scm.
(define j-batch
  (assoc-in j-batch (list :invariants)
            (append invariants
                    (list (property "witness: a settlement failed on a third party's head claim" (w)
                            (every (lambda (r) (null? (:bad r))) (:failures w)))))))
