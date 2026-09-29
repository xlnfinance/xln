;; Planted bug: the chain is not atomic. A failing op leaves the ops before it applied (with the
;; nonce unchanged), and dispute ops are bundled (the counter first) so a batch can fail half way. The retry applies
;; the deposit again.
(define (pick-ops draft)
  (let ((disputes (filter dispute-op? draft)))
    (if (pair? disputes) (reverse disputes) draft)))
(define (fail-batch w b fault?)
  (let ((partial (let loop ((rest (:ops b)) (acc w))
                   (if (or (null? rest) (not (op-ok? acc (car rest) (:reserve acc))))
                       acc
                       (loop (cdr rest) (apply-op acc (car rest)))))))
    (update-in partial (list :failures)
               (lambda (r) (let ((rec (dict :ops (:ops b) :now (:now w) :nonce (:nonce w) :dispute? #f :stale-only? #f))) (if (member rec r) r (append r (list rec))))))))
