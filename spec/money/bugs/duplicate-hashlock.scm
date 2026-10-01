;; Planted bug (R-ONE-LOCK-PER-HASH, coordinator 09-30): a second lock on a hashlock that is already open is accepted, so one secret pays two clauses.
(define (lock-rule h)
  (guarded (str "lock 1 on " h)
           (lambda (w side) (< (length (:clauses w)) max-clauses))
           (lambda (w side)
             (update-in w (list :clauses) (lambda (cs) (append cs (list (dict :payer side :amount 1 :hash h))))))))
