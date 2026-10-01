;; Planted bug: the sender resolves its peer's address once and never again. A stale entry is never replaced, so no frame
;; ever reaches the peer.
(define refresh
  (rule "refresh" (w side)
    (when #f)
    (then w)))
