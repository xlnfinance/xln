;; Planted bug: a responder whose own frame is still unacked does not look for a better proof to answer with:
;; it closes at once on the starter's proof, which can be older than a frame both sides acked (B2).
(define (responder-can-answer? w)
  (let ((d (:dispute w)))
    (and d (counter-window-open? w d) (not (own-ack-pending? w (responder-of d)))
         (> (best-rank w (responder-of d)) (rank (selected d))))))
