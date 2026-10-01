;; Planted bug: the chain waits for the deadline even when the secret is already public, so a
;; finalize that H1 allows is reverted (and, being a dispute batch, takes no nonce).
(define (h1-wait-over? w) (> (:now w) a-deadline))
