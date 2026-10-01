;; Planted bug: a batch carrying a deposit leg soft-fails like a payment batch: it takes its nonce and emits
;; BatchFailed (coordinator J5 refinement, 22:31). A relayer that makes the token pull fail (an allowance
;; withdrawn, a balance spent) burns the Entity's nonce with a batch the Entity signed for other reasons.
(define (hard-op? op) (dispute-op? op))
