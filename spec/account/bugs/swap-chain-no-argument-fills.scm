;; Planted bug (R-SWAP-ONCHAIN): a missing taker argument (ratio 0) fills the whole clause. The stock transformer
;; reads it as a 0% fill, never a revert and never a full fill.
(define (chain-leg amount r) (if (= r 0) amount (quotient (* amount r) max-ratio)))
