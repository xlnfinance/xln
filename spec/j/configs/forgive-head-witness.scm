;; Witness for settlement forgiveness: a claim is forgiven. Adds an invariant that says it never happens; the check must FAIL
;; on it. Loaded after j/configs/forgive-head.scm.
(define j-batch
  (assoc-in j-batch (list :invariants)
            (append invariants
                    (list (property "witness: a settlement forgives the head claim" (w) (null? (:forgiven w)))))))
