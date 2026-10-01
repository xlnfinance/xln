;; A repeated message in the clock world: Left's expire against Right's x, no loss, one repeat. A copy of an earlier attempt can arrive after
;; a later attempt was refused: the receiver answers it from its mark (`stale_attempt`) (bug `below-mark-judged`).
(define left-txs  (vector "expire"))
(define right-txs (vector "x"))
(define conflicts (vector))
(define max-losses 0)
(define max-dups 1)
;; one retry (the budget is 1): the state space of the repeat with the slots is an order larger otherwise
(define max-attempt 1)
