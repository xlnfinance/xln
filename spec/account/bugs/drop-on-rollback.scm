;; Planted bug: right forgets its own frame's txs when it yields to left.
(define (roll-back r) (assoc-in r (list :pending) #f))
