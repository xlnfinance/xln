;; Planted bug: an abort requeues every op of the abandoned batch, deposits included. The abandoned
;; batch still lands (it is final at its nonce and anyone can push it), so the deposit is applied twice.
(define (requeuable w ops) (not-done w ops))
