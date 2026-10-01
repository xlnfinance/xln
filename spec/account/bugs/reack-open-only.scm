;; Quint's rule (account_core.qnt onPropose): a repeat of the frame I last committed is re-acked only while I am Open.
;; A replica that has already proposed its own next frame refuses it, so the ack that was lost is never re-sent.
(define (on-frame side r f)
  (cond
    ((equal? (:prev f) (:head r))
     (cond
       ((and (:pending r) (equal? side :left)) (ignore r))
       ((not (frame-valid? (committed-in-order r) (:txs f))) (ignore r))
       (else (accept r f))))
    ((and (not (:pending r)) (equal? (frame-hash f) (:head r))) (dict :replica r :sent (list (ack-msg (frame-hash f)))))
    (else (ignore r))))
