;; A bound for the J page: R-FUNDED with two payments of different cost (coordinator, 09-30 15:23). The reserve is 1: the
;; first payment r2 costs 2 and does not fit; the second, r1, costs 1 and does. The planner signs oldest first, SKIPPING the
;; one that does not fit, so r1 goes out and r2 waits in the draft. No deposit is involved. No abort. The goal: r1 landed and
;; the Entity is idle. Loaded after j/batch.scm.
(define ops (vector "r2" "r1"))
(define max-aborts 0)
(define (r1-landed? w)
  (and (member "r1" (:done w)) (equal? (:phase w) :idle) (null? (:unsent w))))
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "r2" "r1")) (assoc-in (list :reserve) 1) (assoc-in (list :seed) 1))
        :next next :invariants invariants :at-rest (list) :goal r1-landed?))
