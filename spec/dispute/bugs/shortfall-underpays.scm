;; Planted bug: one unit less than the spendable reserve is paid
(define (payable w side) (max 0 (- (get-in w (list :reserve side)) (older-of w side) 1)))
