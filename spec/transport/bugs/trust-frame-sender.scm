;; Planted bug: the receiver believes the sender field of a frame and does not check the signature. A stranger that writes
;; "from a" on a frame gets it applied.
(define (frame-authentic? m) #t)
