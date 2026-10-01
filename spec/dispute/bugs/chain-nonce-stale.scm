;; Planted bug: a timeout finalize does not consume a nonce: the chain nonce stays at the initial
;; proof's (the contract adds one).
(define (finalized w d p outcome path)
  (let ((paid (payout w (final-delta w p outcome))))
    (-> paid
        (assoc-in (list :dispute) #f)
        (update-in (list :epoch) (lambda (e) (+ e 1)))
        (assoc-in (list :chain-nonce) (p-nonce p))
        (assoc-in (list :head) (length script))
        (assoc-in (list :unacked) #f)
        (update-in (list :results) (lambda (rs) (cons (record w paid d p outcome path) rs))))))
