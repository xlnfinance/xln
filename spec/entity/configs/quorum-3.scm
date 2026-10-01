;; Quorum 3 of 3: the LOCKED phase of xln.ts (28773) becomes real. A validator that signs a proposal does not commit
;; at once; it locks, precommits to everyone and waits for the third signature. A conflict between a certified frame
;; and a locked replica is then testable (it cannot arise: the replica's own signature is one of the three).
;; One height keeps the bound small (the two-height run at quorum 3 did not finish in 36 CPU-minutes); the goal is
;; that every replica commits the same frame.
(define quorum 3)
(define max-height 1)
(define (done? w)
  (and (pair? (:committed (:a w)))
       (every (lambda (r) (equal? (:committed (r w)) (:committed (:a w)))) replicas)))
(define entity-consensus
  (dict :init init :next next :invariants invariants :at-rest (list) :goal done?))
