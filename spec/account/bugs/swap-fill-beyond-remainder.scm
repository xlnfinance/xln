;; Planted bug (R-SWAP-FILL): the whole fill (65535) takes the amounts OFFERED, not what remains. After a partial fill
;; it takes more of a leg than is left, so the taker gets more than the maker still had on offer.
(define (fill-amounts i o r)
  (if (= r max-ratio)
      (list (:give (menu-ref i)) (:want (menu-ref i)))
      (list (fill-leg (rem-give i o) r) (fill-leg (rem-want i o) r))))
