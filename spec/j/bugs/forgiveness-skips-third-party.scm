;; Planted bug: a third party's claim at the head ends the walk instead of reverting the settlement: the settlement lands,
;; having forgiven part of what it listed.
(define (forgive-walk queue ids)
  (let loop ((ids ids) (queue queue) (removed (list)))
    (cond ((or (null? ids) (null? queue) (not (= (car ids) (:id (car queue)))) (not (equal? (:creditor (car queue)) :cp)))
           (dict :ok? #t :removed removed))
          (else (loop (cdr ids) (cdr queue) (append removed (list (car ids))))))))
