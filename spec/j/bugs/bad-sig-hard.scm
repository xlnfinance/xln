;; Planted bug: what the contracts do today for a bad counterparty signature inside a batch: the batch
;; reverts and takes no nonce (coordinator J5 refinement, 22:31). A settlement or C2R signed at an old
;; account epoch then blocks every batch signed above it, and the Entity hears nothing.
(define (fail-hard? w ops bad) (or (some hard-op? ops) (pair? bad)))
