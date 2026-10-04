;; Planted bug (R-SWAP-ONCHAIN): the chain's fill of a clause rounds up on each leg (the stock transformer floors).
(define (chain-leg amount r) (quotient (+ (* amount r) (- max-ratio 1)) max-ratio))
