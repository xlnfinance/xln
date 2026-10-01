;; The arithmetic of one Account's money, in one place. Both the ledger page (money/ledger.scm) and the
;; dispute page (dispute/dispute.scm) build their frames and deposits from these functions, so the two
;; pages cannot disagree about what a payment, a deposit or the credit bound is (composition, round 2).
;; Each page still checks the result against the formula written out again in its own properties, so a
;; wrong function here is caught on both pages (planted bugs `core-pay-flipped`, `core-rcpan-weak`).
;;
;; Δ = ondelta + offdelta is LEFT's allocation. A payment by Left lowers it, a payment by Right raises it.
;; RCPAN: -credit-left <= Δ - (what Left has locked) and Δ + (what Right has locked) <= collateral + credit-right.
;; A Left deposit raises ondelta with the collateral (Account.sol:1251-1257); a Right deposit does not.

(define (ledger-pay off payer amount) (if (equal? payer :left) (- off amount) (+ off amount)))

(define (ledger-rcpan-ok? delta left-locked right-locked collateral credit-left credit-right)
  (and (>= (- delta left-locked) (- credit-left))
       (<= (+ delta right-locked) (+ collateral credit-right))))

(define (ledger-deposit-ondelta ondelta beneficiary amount)
  (+ ondelta (if (equal? beneficiary :left) amount 0)))
