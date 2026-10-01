;; Planted bug: a side may lower the credit it extends below what is already drawn.
(define (credit-rule amount)
  (rule (str "credit " amount) (w side)
    (when (and (<= amount max-credit) (not (= (get-in w (list (credit-key side))) amount))))
    (then (assoc-in w (list (credit-key side)) amount))))
