;; Planted bug: the walk does not check the creditor: a settlement deletes claims owed to a third party.
(define (forgive-walk queue ids)
  (let loop ((ids ids) (queue queue) (removed (list)))
    (cond ((or (null? ids) (null? queue) (not (= (car ids) (:id (car queue))))) (dict :ok? #t :removed removed))
          (else (loop (cdr ids) (cdr queue) (append removed (list (car ids))))))))
