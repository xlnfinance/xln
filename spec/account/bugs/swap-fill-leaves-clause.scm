;; Planted bug (R-SWAP-CLAUSE-WITH-FILL): the stale clause. The fill moves the offdeltas and records the fill, but
;; the frame keeps the clause of the old amounts. The contract has no memory of fills: a dispute from that body
;; lets the taker fill the same amount again.
(define (clause-after-fill w i o2) (list-ref (:clauses w) i))
