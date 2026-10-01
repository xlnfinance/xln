;; Planted bug: a settlement is offered while an HTLC clause is open. Folding offdelta into ondelta
;; forgets the clause; v1 settles only clause-free states.
(define (settle-clause-ok? w) #t)
