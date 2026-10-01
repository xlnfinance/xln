;; Planted bug (R-COSIGN-FREEZE): a frozen side accepts a peer frame. The frame moves offdelta after the fold was signed, so the settlement that
;; lands folds an offdelta the Account no longer has: the signed fold and the off-chain state disagree. Config freeze.
(define (refuses-frozen? r) #f)
