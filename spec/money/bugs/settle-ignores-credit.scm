;; Planted bug (R-SETTLE-CREDIT, coordinator 09-30, Q-X-3): a collateral withdrawal (C2R) is co-signed without checking the credit bound after it.
;; A party withdraws more collateral than its own claim; the counterparty signs; after it lands the withdrawer's allocation sits below the credit the
;; other side extended (seen on the test rig: Left at delta -7,000,031 against credit 18,092). The contract accepts it, since credit is off-chain.
(define c2r-rule
  (rule "c2r 1" (w side)
    (when (>= (:collateral w) 1))
    (then (move-collateral w side -1))))
