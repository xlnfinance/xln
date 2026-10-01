;; Planted bug (attempt number): the proposer re-proposes at the SAME attempt after a refusal. The retry is the very frame the receiver refused
;; (same attempt, same slot), at an attempt it already holds the mark for: refused again, for ever.
(define (next-attempt r m) (:attempt r))
(define (proposal-slot side r) (slot-above side (used-slot r) (max (used-slot r) (:peer-high r))))
