;; Planted bug: a forwarded tx that is already committed is appended to the mempool again.
(define (on-fwd w side m)
  (let ((r (side w)) (t (:tx m)))
    (if (member t (:mempool r))
        w
        (update-in w (list side :mempool) (lambda (mp) (append mp (list t)))))))
