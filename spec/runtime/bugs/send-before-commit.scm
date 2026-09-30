;; Planted bug: the frame's output leaves as soon as the input is applied, before its WAL row is
;; committed. A crash then leaves a peer holding an output of a frame that no longer exists.
(define (fatal-free w i)
  (let ((row (row-for w i)))
    (-> (applied w row)
        (update-in (list :queue) cdr)
        (assoc-in (list :staged) row)
        (update-in (list :sent) (lambda (s) (append s (list (row-output row)))))
        (update-in (list :received) (lambda (r) (append r (list (row-output row)))))
        (assoc-in (list :ts) (row-ts row)))))
