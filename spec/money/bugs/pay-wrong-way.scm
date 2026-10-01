;; Planted bug: a payment moves the allocation the wrong way (the payee pays).
(define (pay-rule amount)
  (guarded (str "pay " amount) (lambda (w side) #t) (lambda (w side) (add-offdelta w (peer side) amount))))
