;; Planted bug: the Entity signs a batch without simulating it at the head (Runtime rule, coordinator 01:16): a finalize
;; is signed before the H1 gate opens, reverts, and the batch waits signed at its nonce.
(define (simulated-ok? w ops) #t)
