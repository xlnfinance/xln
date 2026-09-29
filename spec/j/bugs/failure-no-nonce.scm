;; Planted bug: what the contracts do today. A batch whose ops fail reverts and takes no nonce and
;; emits nothing (coordinator R-J5): a signed batch is final at its nonce, so every urgent batch
;; above it would wait for a nonce the chain never reaches.
(define (fail-batch w b fault?)
  (update-in w (list :failures)
             (lambda (r) (append r (list (dict :ops (:ops b) :now (:now w) :nonce (:nonce b) :dispute? #f :stale-only? #f))))))
