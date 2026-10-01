;; Planted bug: a node that receives a frame addressed to an entity it does not host halts. A stale directory entry then
;; stops the wrong node instead of costing the sender a resend.
(define (send-frame w h)
  (if (equal? (:dir w) "b")
      (put w (msg "frame" "a" "b" h (sendable-body w h) "ok"))
      (assoc-in w (list :halted) "old")))
