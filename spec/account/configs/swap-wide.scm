;; A wider bound for the swap page: offers at height 0 or 1 (deadlines 1 and 2), a clock of 4 so a lapse (past
;; deadline + 1) fits for both, and a different taker ratio, 50000, whose floors leave a remainder of (1, 1).
(define max-now 4)
(define max-offer-now 1)
(define taker-ratios (list 1 50000 65535))
