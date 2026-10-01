;; Planted bug (R-PROOF-NONCE-ABOVE-SIGNED): a replica that yields (it has a frame out) commits the winner's frame without asking whether it
;; ranks above the proof it signed itself. Right signs a retry at attempt 1 (nonce base + 2), then yields to Left's first frame (nonce base + 1):
;; the committed frame is below a proof Right holds, and that proof could still be presented in its place. Config right-expire.
(define (above-signed? r f) (or (and (:pending r) #t) (> (frame-rank f) (signed-top r))))
