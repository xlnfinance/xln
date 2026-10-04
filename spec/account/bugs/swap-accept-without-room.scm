;; Planted bug (R-SWAP-CONSENT): the taker's first fill is accepted without asking whether its RCPAN holds with the whole
;; want reserved (no insufficient_capacity). A fill can then ask the taker for funds it does not have.
(define (accept-fits? w i o) #t)
