;; Planted bug: a frame whose signature does not verify halts the receiver instead of being refused. Any stranger that can
;; reach the address can stop the node.
(define (b-receive w m)
  (cond ((not (equal? (m-kind m) "frame")) (refuse w "unexpected"))
        ((not (frame-authentic? m)) (assoc-in w (list :halted) "b"))
        (else (receive-frame w m))))
