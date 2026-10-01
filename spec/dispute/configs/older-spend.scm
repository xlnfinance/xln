;; A bound for the dispute page: the debtor's older debt is smaller than its reserve, so after enforcement some reserve is still spendable and the peer must get it. Left owes third parties 1, its reserve is 2. Loaded after dispute.scm.
(define rivals (list))
(define older-left0 1)
(define reserve-left0 2)
(define init (-> init (assoc-in (list :older :left) 1) (assoc-in (list :reserve :left) 2)))
(define dispute (dict :init init :next next :invariants invariants :steps steps :at-rest (list) :goal settled?))
