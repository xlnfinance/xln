;; Planted bug: the cooperative settlement is signed at a nonce as high as the baselines the parties
;; already hold for the epoch it opens. The chain nonce lands on them, so neither side holds a valid
;; proof of the new epoch (N1 nonce continuity).
(define (settle-nonce w) (+ (:head w) 3))
