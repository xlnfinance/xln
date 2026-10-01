;; Planted bug: enforcement ignores the per-call cap
(define (enforce-older w side)
  (let ((pay (min (older-of w side) (get-in w (list :reserve side)))))
    (-> w (add-reserve side (- pay)) (update-in (list :older side) (lambda (o) (- o pay)))
          (update-in (list :third-paid) (lambda (t) (+ t pay))))))
