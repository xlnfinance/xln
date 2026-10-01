;; A second bound for the routing page: the payer's lock is one tick beyond MAX_LOCK_HORIZON. The hub
;; must refuse to forward (deadline_too_far); nothing is forwarded and nothing can be lost.
(define d-in 6)
