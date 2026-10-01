;; Planted bug: the receiver does not run its own RCPAN check on a frame it signs. An honest proposer
;; never sends an overdrawing frame, so only a Byzantine one shows it: the receiver's check is the one
;; thing standing between it and a held proof that overdraws the proposer.
(define (receiver-ok? w p) #t)
