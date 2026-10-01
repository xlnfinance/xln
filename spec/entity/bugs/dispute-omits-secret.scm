;; Planted bug: the dispute start carries only the secrets already public, not the ones H knows
;; (R3 dropped): the starter's evidence is frozen at start.
(define (start-publishes w) (:h-public-at w))
