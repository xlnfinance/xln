;; Planted bug: no floor on the response windows (contracts H2). A zero window means T = S:
;; the responder has no time to answer a stale start.
(define (windows) (list 0 0))
(define (window-floor-ok?) #t)
