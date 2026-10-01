;; Planted bug: the settlement reverts when EITHER side's head claim is owed to a third party, even if the other side's head
;; was forgiven (the contract reverts only when nothing was forgiven).
(define (forgive-lands? w fe fc)
  (and (or fe (null? (:debts w))) (or fc (null? (:cp-debts w)))))
