;; Planted bug (R-SWAP-CONSENT): a quote is written into the signed body as a clause. A maker can fill a proof body with
;; clauses the taker never saw, and a dispute lets the taker be settled against a quote it never accepted.
(define (quote-clause i o)
  (dict :give (rem-give i o) :want (rem-want i o) :allow-give (rem-give i o) :allow-want (rem-want i o)))
