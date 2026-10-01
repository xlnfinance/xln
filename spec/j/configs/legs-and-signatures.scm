;; A third bound for the J page: a deposit leg, a reserve deposit and a settlement whose counterparty signature
;; goes bad when the counterparty settles Account A elsewhere (epoch-moves 1), one batch fault (a token pull that
;; is refused, a reserve spent), no abort. It exercises the J5 refinement: a batch with a deposit leg reverts
;; whole and takes no nonce; a bad counterparty signature is a soft fail (BatchFailed names the bad op, the
;; Account gets it back). Loaded after j/batch.scm.
(define ops (vector "x1" "r1" "stl-a"))
(define draft-cap 3)
(define max-aborts 0)
(define epoch-moves 1)
(define j-batch
  (dict :init (assoc-in (assoc-in init (list :unsent) (list "x1" "r1" "stl-a")) (list :faults) 1)
        :next next :invariants invariants :at-rest (list) :goal finished?))
