;; A second bound for the swap page: no credit either way. Both offers cannot be open at once (Left's holds on :a would be
;; 3 + 1 against a balance of 3), so the second offer is refused while the first is open, and RCPAN is tight on both tokens.
(define credit-left 0)
(define credit-right 0)
