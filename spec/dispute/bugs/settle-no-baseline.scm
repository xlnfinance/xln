;; Planted bug: the settlement co-signs no new baseline for the epoch after the one it opens (it holds
;; a stale one again). A dispute in the new epoch, before another frame is signed, ends with no valid
;; proof for either side.
(define (settle-baseline w) (baseline-of 0 1))
