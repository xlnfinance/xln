;; Planted bug: the chain is not atomic. A failing op leaves the ops before it applied (with the
;; nonce unchanged), and finalizes are bundled so a batch can fail half way. The retry applies
;; the deposit again.
(define (pick-ops draft) draft)
(define (revert w b)
  (let ((partial (let loop ((rest (:ops b)) (acc w))
                   (if (or (null? rest) (not (op-ok? acc (car rest) (:reserve acc))))
                       acc
                       (loop (cdr rest) (apply-op acc (car rest)))))))
    (update-in partial (list :reverts)
               (lambda (r) (let ((rec (dict :ops (:ops b) :now (:now w)))) (if (member rec r) r (append r (list rec))))))))
