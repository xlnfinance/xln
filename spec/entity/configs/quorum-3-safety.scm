;; Quorum 3 of 3, safety only: the same bound as quorum-3.scm without the liveness goal (that one fails, Q-E-8). Every
;; safety property holds at quorum 3, the locked phase included.
(define entity-consensus
  (dict :init init :next next :invariants invariants :at-rest (list)))
