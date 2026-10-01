;; Planted bug (R-SWAP-ALLOWANCES): the clause carries no allowance on the want leg. The chain's finalize reverts
;; a clause that changes a delta it has no allowance for, so no dispute can settle while the offer is open.
(define (clause-for i o)
  (and (open? o) (dict :give (rem-give i o) :want (rem-want i o) :allow-give (rem-give i o) :allow-want #f)))
