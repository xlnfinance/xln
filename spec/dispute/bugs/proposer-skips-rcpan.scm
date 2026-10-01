;; Planted bug: an honest proposer does not run its own RCPAN check before it signs. The receiver
;; refuses the frame, but the proposer has already signed a body that overdraws it.
(define (proposer-ok? w p) #t)
