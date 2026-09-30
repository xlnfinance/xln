;; A bound for the J page where the counter is queued before the finalize, so the counter can land first and the
;; finalize prepared for the initial proof can never apply (R-J2 extended, coordinator 23:42). No abort.
(define ops (vector "cnt-a" "fin-a"))
(define max-aborts 0)
(define j-batch
  (dict :init (assoc-in init (list :unsent) (list "cnt-a" "fin-a"))
        :next next :invariants invariants :at-rest (list) :goal finished?))
