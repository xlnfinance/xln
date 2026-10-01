;; Planted bug: a frame whose signature does not verify halts the receiver instead of being refused. Any stranger that can
;; reach the address can stop the node.
(define (b-receive w m)
  (if (frame-authentic? m) (receive-frame w m) (assoc-in w (list :halted) "b")))
