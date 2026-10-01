;; A second bound for the J page: one payment batch fails on chain (a reserve spent elsewhere) and there
;; is no abort. It exercises R-J5 (a failed batch takes its nonce, BatchFailed) on its own, so the base
;; page stays within the time budget. Loaded after j/batch.scm.
(define max-aborts 0)
(define j-batch
  (dict :init (assoc-in init (list :faults) 1) :next next :invariants invariants :at-rest (list) :goal finished?))
