;; Planted bug: a frame that does not extend my head is committed anyway.
(define (on-frame side r f)
  (if (and (:pending r) (equal? side :left) (equal? (:prev f) (:head r)))
      (ignore r)
      (accept r f)))
