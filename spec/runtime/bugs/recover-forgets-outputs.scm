;; Planted bug: recovery believes the outputs of the replayed rows already left. A crash between the
;; WAL commit and the flush then leaves a peer that never receives an output the Runtime committed.
(define recover
  (rule "recover" (w side)
    (when (:crashed w))
    (then (-> w (assoc-in (list :crashed) #f)
                (assoc-in (list :state) (replay-state w))
                (assoc-in (list :ts) (last-ts w))
                (assoc-in (list :height) (length (:wal w)))
                (assoc-in (list :sent) (wal-outputs w))))))
(define rules (list apply-input commit flush crash recover tick-clock))
(define (next w) (successors rules sides w))
