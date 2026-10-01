;; Planted bug: a resolved clause moves the payee's offdelta instead of the payer's (the payment lands on the wrong side).
(define (clause-rule verb i pays?)
  (guarded (str verb " " i)
           (lambda (w side) (and (< i (length (:clauses w))) (equal? (:payer (nth-clause w i)) side)))
           (lambda (w side)
             (let ((c (nth-clause w i)))
               (if pays? (add-offdelta (without-clause w i) (peer side) (:amount c)) (without-clause w i))))))
