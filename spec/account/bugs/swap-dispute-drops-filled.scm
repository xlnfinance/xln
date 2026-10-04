;; Planted bug (R-SWAP-CLAUSE-WITH-FILL, R-SWAP-ONCHAIN): the dispute settles from the clause remainder and forgets
;; the part that was filled: it starts from the offdeltas before the fills, so a fill is lost.
(define (settle-base w tok) (- (get-in w (list :off tok)) (filled-delta w tok)))
