;; Planted bug (R-IMPLICIT-BASELINE): the implicit proof carries the chain nonce itself instead of chain + 1, so it is
;; not above the stored nonce and cannot start a dispute. After an epoch advance a side that holds no signed
;; frame of the new epoch has no valid proof.
(define (implicit-proof w)
  (list (:chain-nonce w) :right 0 #f #f (:epoch w) (car (windows)) (cadr (windows)) #t))
