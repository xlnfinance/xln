;; Planted bug: only Left's older debts are enforced
(define (enforce-older w side)
  (if (equal? side :left)
      (let ((pay (min (older-of w side) (get-in w (list :reserve side)) older-per-call)))
        (-> w (add-reserve side (- pay)) (update-in (list :older side) (lambda (o) (- o pay)))
              (update-in (list :third-paid) (lambda (t) (+ t pay)))))
      w))
