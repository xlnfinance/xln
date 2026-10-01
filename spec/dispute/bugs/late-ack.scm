;; Planted bug: the ack of a frame may reach its proposer after the response window closed (the
;; assumption "ack delay < window" is dropped). A dispute can then end on a proof one frame behind
;; what both sides had committed (Q-D-3).
(define (ack-in-window?) #f)
