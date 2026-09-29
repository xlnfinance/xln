;; Planted bug: a finalize is bundled with the other ops in the draft. While Account A's HTLC
;; deadline is open the finalize reverts, and the whole batch with it: an unrelated deposit is
;; held up by another Account's deadline (coordinator N2).
(define (pick-ops draft) draft)
