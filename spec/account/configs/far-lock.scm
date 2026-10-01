;; The other retryable fault: a lock whose deadline is beyond the horizon of the judging view (`deadline_too_far`, MAX_LOCK_HORIZON). The lock
;; is applicable only while view < deadline <= view + horizon, so it is too far at view 0, applicable at view 1 and passed from view 2.
;; A receiver whose view lags refuses what the proposer's view allows, and the proposer retries it at the next attempt.
(define left-txs  (vector "lock"))
(define right-txs (vector "x"))
(define conflicts (vector))
(define max-losses 1)
(define lock-deadline 2)
(define lock-horizon 1)
