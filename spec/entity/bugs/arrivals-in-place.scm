;; Planted bug: the pool is folded in the order it arrived, arrivals and txs mixed. A payment
;; that came in before a peer's credit is refused for room that the same frame then receives
;; (lessons R-E1).
(define (frame-fold w pool)
  (let* ((before (length (:admitted w)))
         (w2 (fold-inputs (lambda (acc i) (if (arrival? i) (arrive acc i) (admit acc i))) w pool))
         (admitted (list-tail (:admitted w2) before))
         (touched (first-touch admitted))
         (order (propose-order w2 touched))
         (w3 (fold-inputs propose w2 order)))
    (-> w3 (assoc-in (list :pool) (list))
           (update-in (list :count) (lambda (n) (+ n 1)))
           (update-in (list :frames) (lambda (fs) (cons (dict :admitted admitted :touched touched :proposed order) fs))))))
