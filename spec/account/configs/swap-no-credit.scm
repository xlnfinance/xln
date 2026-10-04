;; A second bound for the swap page: no credit either way. Both offers cannot be accepted at once (Left's holds on :a would be
;; 3 + 1 against a balance of 3), so the two cannot both be accepted: the taker's first fill of a quote is refused for room
;; (insufficient_capacity) while the other offer holds its want, and RCPAN is tight on both tokens.
(define credit-left 0)
(define credit-right 0)
