;; Planted bug: the listed token ids are not read; any listing forgives the head claims of the token that carries debts.
(define (forgive-plan w)
  (let ((ids (forgive-ids)))
    (cond ((forgive-over-cap? ids) (dict :ok? #f :entity #f :cp #f))
          ((repeated? ids) (dict :ok? #f :entity #f :cp #f))
          ((null? ids) (dict :ok? #t :entity #f :cp #f))
          (else (let ((fe (forgivable-entity? w)) (fc (forgivable-cp? w)))
                  (dict :ok? (forgive-lands? w fe fc) :entity fe :cp fc))))))
