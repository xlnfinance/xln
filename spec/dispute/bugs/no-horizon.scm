;; Planted bug: nobody checks the lock's deadline against MAX_LOCK_HORIZON (loaded with the far-deadline
;; config). A lock whose deadline is beyond the horizon is signed and, under H1, blocks close until the
;; secret appears.
(define (horizon-ok? w p) #t)
