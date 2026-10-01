;; A bound for the J page with a dispute START (it carries the account's ondeltaEpoch) and a settlement that moves the
;; epoch, and the counterparty may move it too (epoch-moves 1): a start signed for epoch 0 must skip once the epoch moved.
(define ops (vector "start-a" "stl-a"))
(define max-aborts 0)
(define epoch-moves 1)
(define j-batch
  (dict :init (assoc-in init (list :unsent) (list "start-a" "stl-a"))
        :next next :invariants invariants :at-rest (list) :goal finished?))
