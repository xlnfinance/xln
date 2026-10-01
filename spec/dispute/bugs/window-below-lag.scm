;; Planted bug: the response window is not required to exceed LAG (the time to read a J event and
;; get an op included). With LAG one tick and windows of one tick, the responder sees the start at
;; S + LAG and its counter lands at T or later: it has no time to answer a stale start.
(define lag 1)
(define (window-floor-ok?) (every (lambda (x) (>= x min-window)) (windows)))
