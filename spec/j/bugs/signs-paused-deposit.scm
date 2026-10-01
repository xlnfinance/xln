;; Planted bug: the Entity signs a deposit while its token is paused (it does not simulate at the head). The batch
;; reverts on chain, takes no nonce and stalls every batch above it until the token resumes.
(define (deposit-signable? w) #t)
