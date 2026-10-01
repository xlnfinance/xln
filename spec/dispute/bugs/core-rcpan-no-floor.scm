;; Planted bug: the shared credit bound forgets its lower side (money/core.scm): Left may go below the credit
;; Right extended. Both pages build their guards from it, so both must catch it.
(define (ledger-rcpan-ok? delta left-locked right-locked collateral credit-left credit-right)
  (<= (+ delta right-locked) (+ collateral credit-right)))
