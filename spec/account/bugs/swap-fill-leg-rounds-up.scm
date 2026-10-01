;; Planted bug (R-SWAP-FILL): the want leg of a fill rounds UP. The give leg floors and the want leg ceils, so the legs
;; no longer follow the price: the taker pays up to a unit more than its share and the maker is paid it, value made
;; out of rounding.
(define (fill-amounts i o r)
  (list (fill-leg (rem-give i o) r)
        (quotient (+ (* (rem-want i o) r) (- max-ratio 1)) max-ratio)))
