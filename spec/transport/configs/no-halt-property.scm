;; Loaded after the page: the flag property "no peer message halts a node" is removed, so a halt can only be seen by liveness
;; (a halted node takes no further step, which is a dead end). Each halt bug must still fail, on "can always still finish".
(define transport
  (assoc-in transport (list :invariants) (list (car invariants) (cadr invariants))))
