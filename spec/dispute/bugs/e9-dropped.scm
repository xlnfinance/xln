;; Planted bug (N3, E9; review round 3 of PR 41, w1): the chain's E9 check is removed, a counter or a final body may shorten
;; the started windows. The signing guard stays, so no honest frame shortens them: the bug is only live against a proof one party
;; signed ALONE (load after `configs/byz-window.scm`): Left counters a start from the long-window frame with Right's lone
;; floor-window proof, and the dispute closes on windows below the ones it started with. With E9 in place that proof can
;; start a dispute but never answer one.
(define (windows-ok? d p) #t)
