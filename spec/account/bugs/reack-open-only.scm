;; Quint's rule (account_core.qnt onPropose): a repeat of the frame I last committed is re-acked only while I am Open.
;; A replica that has already proposed its own next frame refuses it, so the ack that was lost is never re-sent.
(define (reack? r f) (and (not (:pending r)) (equal? (frame-hash f) (:head r))))
