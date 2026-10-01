;; A bound for the dispute page: Left already owes third parties 2 from before and one enforcement call clears 1 (the contract's cap
;; of 32 claims per call, here 1), and Left's reserve is 2. A shortfall owed by Left enforces 1 of the older debt first, leaving
;; reserve 1 and older debt 1: the peer is paid out of the SPENDABLE reserve, which is 0 (Depository._settleShortfall). No
;; cross-open. Loaded after dispute.scm; the page's init and its spec dict capture these at definition, so both are rebuilt.
(define rivals (list))
(define older-left0 2)
(define older-per-call 1)
(define reserve-left0 2)
(define init (-> init (assoc-in (list :older :left) 2) (assoc-in (list :reserve :left) 2)))
(define dispute (dict :init init :next next :invariants invariants :steps steps :at-rest (list) :goal settled?))
