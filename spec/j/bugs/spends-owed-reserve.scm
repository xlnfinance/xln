;; Planted bug: the Entity counts the whole reserve as spendable, the debts beyond the enforcement cap included. It signs a
;; payment against money that is owed; the chain refuses it (the reserve net of debt is 0) and the nonce is burnt.
(define (spendable w) (:reserve w))
