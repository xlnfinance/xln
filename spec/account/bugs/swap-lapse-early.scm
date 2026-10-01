;; Planted bug (R-SWAP-EXPIRE): an offer can be lapsed before its deadline. The maker's offer is gone before it expired.
(define (lapse-due? w o) #t)
