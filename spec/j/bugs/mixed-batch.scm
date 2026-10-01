;; Planted bug: dispute ops and payment ops share a batch (coordinator R-SPLIT). A mixed batch that
;; fails reverts whole and takes no nonce, so every batch signed above it stalls.
(define (pick-ops draft) draft)
