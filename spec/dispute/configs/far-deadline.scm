;; A second bound for the dispute page: the HTLC deadline is beyond MAX_LOCK_HORIZON. Both sides refuse
;; the lock frame, so no clause is ever signed and the page must still settle.
(define htlc-deadline 3)
