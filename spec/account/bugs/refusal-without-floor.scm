;; Planted bug (R-PROOF-NONCE-ABOVE-SIGNED): a refusal carries no floor. A stale_slot refusal that does not name the slot that clears it leaves the
;; proposer to find it by retrying.
(define (refusal-floor r) 0)
