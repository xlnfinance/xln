;; Planted bug: the pre-signed baseline of the next epoch sits only two above its frame. A
;; timeout finalize leaves the chain nonce at n0 + 1, so a proposer still waiting for an ack
;; holds a baseline that is not above it: a window with no valid proof, which the counterparty
;; can stretch by refusing to co-sign a new one.
(define (baseline-nonce k) (+ k 2))
