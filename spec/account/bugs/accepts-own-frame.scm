;; Planted bug (frame author): a replica does not look at the author, so a frame handed back to its own author is taken for
;; the peer's and committed without the peer's say (the kernel's `refused_own`; Quint's `f.author != self`).
(define (own-frame? side f) #f)
