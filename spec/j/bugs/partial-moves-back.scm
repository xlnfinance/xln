;; Planted bug: a part-paid claim is reduced and re-queued at the BACK, so the cursor moves past it and a younger claim is
;; paid first at the next call.
(define (requeue-debts debts cleared updated)
  (append (filter (lambda (d) (not (or (member (:id d) cleared) (find (lambda (u) (= (:id u) (:id d))) updated)))) debts)
          updated))
