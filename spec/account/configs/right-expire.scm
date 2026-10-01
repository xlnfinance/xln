;; Right holds the clock-dependent tx: Left's a against Right's expire, which the receiver's view may not allow yet (`not_expired`). Right's frame is
;; refused and retried at attempt 1 (slot 3) while Left's first frame (slot 2) is still in flight: a collision the frame with the higher slot wins
;; (R-PROOF-NONCE-ABOVE-SIGNED, bug `yield-below-own-proof`); refused twice, Right holds proofs above Left's first slot (bug `stale-slot-unchecked`).
;; One lost message, so a refusal can be lost with the frame it answers.
(define left-txs  (vector "a"))
(define right-txs (vector "expire"))
(define conflicts (vector))
(define max-losses 1)
