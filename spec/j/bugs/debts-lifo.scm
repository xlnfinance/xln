;; Planted bug: the chain pays the NEWEST debt first. The oldest creditor waits behind every later one.
(define (debt-order debts) (reverse debts))
