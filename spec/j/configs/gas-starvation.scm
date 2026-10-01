;; A bound for the J page: one batch is reverted for gas (an ERC-1271 member's stipend could not be given), a
;; settlement's counterparty signature may go bad (the counterparty moves the epoch), no abort. It exercises
;; "gas starvation is never BatchFailed" and the co-signed batch on its own.
(define ops (vector "r1" "stl-a"))
(define max-aborts 0)
(define epoch-moves 1)
(define gas-starves 1)
(define j-batch
  (dict :init (assoc-in (assoc-in init (list :unsent) (list "r1" "stl-a")) (list :gas) 1)
        :next next :invariants invariants :at-rest (list) :goal finished?))
