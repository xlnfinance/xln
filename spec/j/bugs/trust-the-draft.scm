;; Planted bug: an event does not clear the ops it applied from the draft. An aborted batch that
;; lands after its ops were requeued is applied a second time by the next batch.
(define (observe-event w e)
  (let* ((w1 (-> w (update-in (list :chain-nonce) (lambda (n) (max n (:nonce e))))
                   (update-in (list :done) (lambda (d) (append d (filter (lambda (op) (not (member op d))) (:ops e)))))))
         (sent (:sent w)))
    (cond ((not (equal? (:phase w) :inflight)) w1)
          ((and (= (:nonce e) (:nonce sent)) (equal? (:hash e) (:hash sent)))
           (-> w1 (assoc-in (list :phase) :idle) (assoc-in (list :sent) #f)))
          ((>= (:nonce e) (:nonce sent)) (assoc-in w1 (list :phase) :quarantined))
          (else w1))))
