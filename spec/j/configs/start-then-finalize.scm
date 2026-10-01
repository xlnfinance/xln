;; A bound for the J page where a start and a finalize are drafted together: the deadline wait (H1) can fail the
;; finalize after the start applied, which shows a chain that is not atomic (bug `partial-apply`). No abort.
(define ops (vector "start-a" "fin-a"))
(define max-aborts 0)
(define j-batch
  (dict :init (assoc-in init (list :unsent) (list "start-a" "fin-a"))
        :next next :invariants invariants :at-rest (list) :goal finished?))
