;; A bound for the dispute page: the mirror of older-debt.scm. RIGHT owes third parties 2, one enforcement call clears 1, Right's reserve is 2: the Right-debtor direction. Loaded after dispute.scm.
(define rivals (list))
(define older-right0 2)
(define older-per-call 1)
(define reserve-right0 2)
(define init (-> init (assoc-in (list :older :right) 2) (assoc-in (list :reserve :right) 2)))
(define dispute (dict :init init :next next :invariants invariants :steps steps :at-rest (list) :goal settled?))
