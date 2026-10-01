;; Witness for R2C-DEBT-FIRST (coordinator, 09-30 15:23): a reserve payment does enforce the queue in more than one internal
;; call. Adds an invariant that says it never happens; the check must FAIL on it. Loaded after j/configs/r2c-debt-first.scm.
(define j-batch
  (assoc-in j-batch (list :invariants)
            (append invariants
                    (list (property "witness R2C-DEBT-FIRST: a reserve payment enforces the queue in two internal calls" (w)
                            (every (lambda (r) (< (:calls r) 2)) (:after-r2c w)))))))
