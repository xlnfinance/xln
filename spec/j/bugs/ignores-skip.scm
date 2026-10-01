;; Planted bug: the Entity does not read DisputeOpSkipped. An op the chain skipped is neither done
;; nor requeued, so the node waits for its effect for ever (a start that was skipped, waiting for a
;; DisputeStarted that never comes).
(define (skip-ops e) (list))
