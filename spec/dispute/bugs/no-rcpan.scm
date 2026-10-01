;; Planted bug: neither side checks RCPAN before it signs a frame. The last payment of the script
;; takes Left past the credit Right extended, and a dispute on it books debt above the credit.
(define (rcpan-ok? w p) #t)
