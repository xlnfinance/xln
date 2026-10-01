;; Planted bug (R-FRAME-EPOCH-WEDGE): the Runtime's close of the epoch also takes every pending frame back off-chain, as if the
;; replicas had already heard it. The close is a chain event: the replicas move only when they hear the chain, and a frame signed
;; under the old pair is still the frame they hold until then.
(define (close-effect w)
  (-> w
      (update-in (list :left) (lambda (r) (if (:pending r) (roll-back r) r)))
      (update-in (list :right) (lambda (r) (if (:pending r) (roll-back r) r)))))
