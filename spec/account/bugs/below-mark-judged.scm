;; Planted bug (attempt number): a frame BELOW the mark is judged afresh (only an equal attempt is answered from the mark).
;; A late copy of an earlier attempt, refused before, commits when the receiver's view has moved: the same fork.
(define (at-or-below-mark? r f) (and (:mark r) (equal? (:attempt f) (:attempt (:mark r)))))
