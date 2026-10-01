;; Planted bug (R-SWAP-FILL): the ratio is not checked: 0 and values above 65535 are accepted (a uint16 holds 65535
;; and the taker is not trusted), and a fill that takes nothing of a leg is not refused either.
(define taker-ratios (list 0 1 32768 65535 65536))
(define (ratio-valid? r) #t)
(define (takes-something? i o r) #t)
