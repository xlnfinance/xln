;; Planted bug: a proposal or certified frame for a height the replica has not reached is consumed
;; and ignored instead of waiting. The proposer has no resend, so it is stranded.
(define (parked? r m) #f)
