;; Planted bug: the receiver assumes the link delivers each message once, so a frame that is not ahead of its head is
;; applied (again) and acked. One duplicate doubles a frame.
(define (receive-frame w m)
  (let ((h (m-h m)) (n (length (:applied w))))
    (if (<= h (+ n 1))
        (put-ack (update-in w (list :applied) (lambda (l) (append l (list (m-body m))))) h)
        (refuse w "future"))))
