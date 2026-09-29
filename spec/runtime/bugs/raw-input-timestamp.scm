;; Planted bug: the frame timestamp is the input's own, not max(runtime, input). A late input
;; drags the clock back.
(define (frame-ts w i) (ts i))
