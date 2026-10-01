;; Planted bug: a lapsed clause pays out anyway.
(define (clause-rule verb i pays?)
  (guarded (str verb " " i)
           (lambda (w side) (and (< i (length (:clauses w))) (equal? (:payer (nth-clause w i)) side)))
           (lambda (w side)
             (let ((c (nth-clause w i)))
               (add-offdelta (without-clause w i) side (:amount c))))))
