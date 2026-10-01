;; Planted bug: retired-board evidence settles in full (the contracts before H3): a leaked retired quorum draws on
;; the retired entity's reserves, and a rotation cannot be told from an attack.
(define (clamp-retired retired delta collateral) delta)
