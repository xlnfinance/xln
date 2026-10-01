;; Planted bug: replay stamps each frame with the current clock instead of the row's own
;; timestamp. The recovered state is not the state that was committed.
(define (replay-state w)
  (filter (lambda (e) e)
          (map (lambda (r) (if (row-entry r) (str (row-input r) "@" (:clock w)) #f)) (:wal w))))
