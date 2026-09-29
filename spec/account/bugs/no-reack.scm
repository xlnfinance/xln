;; Planted bug: a duplicate of the frame at my head is ignored instead of acked again, so a
;; lost ack wedges the proposer forever.
(define (on-frame side r f)
  (cond
    ((equal? (:prev f) (:head r))
     (cond
       ((and (:pending r) (equal? side :left)) (ignore r))
       ((not (frame-valid? (committed-in-order r) (:txs f))) (ignore r))
       (else (accept r f))))
    (else (ignore r))))
