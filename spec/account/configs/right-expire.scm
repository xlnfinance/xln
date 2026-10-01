;; Right holds the clock-dependent tx: Left's a against Right's expire, which the receiver's view may not allow yet (`not_expired`). Right's frame is
;; refused and retried at attempt 1 (proof nonce base + 2) while Left's first frame (nonce base + 1) is still in flight: Right has to yield to a frame
;; that ranks BELOW the proof it signed (R-PROOF-NONCE-ABOVE-SIGNED, bug `yield-below-own-proof`).
(define left-txs  (vector "a"))
(define right-txs (vector "expire"))
(define conflicts (vector))
