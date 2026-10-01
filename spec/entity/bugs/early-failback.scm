;; Planted bug: H fails the route back the moment the onward lock ends, and without looking for a
;; reveal in flight (R2 dropped). B's on-chain reveal at the last moment lands after the refund.
(define (failback-ok? w) (>= (:now w) (:d-out w)))
(define fail-back
  (rule "H fails the route back" (w side)
    (when (and (:forwarded w) (not (:claimed w)) (not (:h-public-at w)) (not (:failed-back w))
               (failback-ok? w)))
    (then (assoc-in w (list :failed-back) #t))))
(define (next w)
  (successors (append (list a-goes-silent (b-reveals "off") (b-reveals "chain") claim-off-chain reveal-on-chain
                            start-dispute fail-back tick)
                      (map forward-with (iota d-in 1)))
              sides w))
