;; A bound for the J page with two deposit legs (two tokens): each travels alone (J6). One fault (a token pull that
;; is refused), no abort.
(define ops (vector "x1" "x2"))
(define max-aborts 0)
(define j-batch
  (dict :init (assoc-in (assoc-in init (list :unsent) (list "x1" "x2")) (list :faults) 1)
        :next next :invariants invariants :at-rest (list) :goal finished?))
