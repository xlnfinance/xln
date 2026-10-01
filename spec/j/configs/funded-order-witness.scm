;; Witness for R-FUNDED (coordinator, 09-30 15:23): the skipping case is reachable. Adds an invariant that says it never
;; happens; the check must FAIL on it, with a trace that signs r1 while r2 waits. Loaded after j/configs/funded-order.scm.
(define j-batch
  (assoc-in j-batch (list :invariants)
            (append invariants
                    (list (property "witness R-FUNDED: a payment that does not fit is skipped while a later one is signed" (w)
                            (null? (:skipped-unfit w)))))))
