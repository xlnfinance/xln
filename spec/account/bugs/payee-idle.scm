;; Planted bug: the payee owes no on-chain reveal, so nothing stops the chain from moving past the deadline while its resolve is unacked. The payer
;; expires the lock and the payee never put the secret on-chain (R-HTLC-CLOCK c).
(define (payee-duty? w) #f)
