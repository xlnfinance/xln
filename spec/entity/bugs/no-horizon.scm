;; Planted bug: the hub forwards a lock whose deadline is beyond MAX_LOCK_HORIZON (loaded with the
;; far-inbound config). Under H1 a lock this far out blocks close until the secret appears.
(define (horizon-ok? d) #t)
