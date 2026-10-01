;; Planted bug: a listed token without debts reverts the settlement; the contract lets it land when nobody has a debt there.
(define (forgive-lands? w fe fc) (or fe fc))
