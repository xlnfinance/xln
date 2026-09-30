;; Planted bug: the chain is not atomic. A failing op leaves the ops before it applied (with the nonce unchanged),
;; and the dispute ops of the draft go out as one batch (a start, then a finalize that waits for its deadline), so a
;; batch can fail half way and the retry applies the start again.
(define (pick-ops draft)
  (let ((disputes (filter dispute-op? draft)))
    (if (pair? disputes) disputes draft)))
(define (fail-batch w b fault?)
  (let ((partial (let loop ((rest (:ops b)) (acc w))
                   (if (or (null? rest) (not (op-ok? acc (car rest) (:reserve acc))))
                       acc
                       (loop (cdr rest) (apply-op acc (car rest)))))))
    (update-in partial (list :failures)
               (lambda (r) (let ((rec (dict :ops (:ops b) :now (:now w) :nonce (:nonce w) :took? #f :bad (list) :gas #f :secret (:secret w) :stale-only? #f))) (if (member rec r) r (append r (list rec))))))))
