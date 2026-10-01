;; Planted bug (R-C2R-FOLD; review round 3 of PR 41, item 4): a collateral-to-reserve withdrawal is co-signed as a plain C2R
;; while the epoch's offdelta is nonzero. processC2R's diff is only the withdrawn amount, nothing folds the offdelta, and the
;; epoch advance makes the signed state of the epoch unusable: Right's payment to Left is erased. (Load after
;; `configs/withdraw.scm`.) The rule: co-sign a C2R only while offdelta is zero, otherwise withdraw through a settlement
;; that folds it.
(define (withdraw-fold off) 0)
