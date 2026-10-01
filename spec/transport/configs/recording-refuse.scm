;; Witness-only: `refuse` records the reason in the world (key :refusals), so a witness can say a refusal HAPPENED, not only that
;; its precondition holds. The main page is untouched: it keeps no refusal record (3,536 states), and this file is loaded only with
;; the three witness configs (load it first: `recording-refuse.scm`, then `witness-<reason>.scm`). The check stops at the first
;; violation, so each witness takes seconds.
(define (refused w) (let ((r (get-in w (list :refusals)))) (if r r (list))))
(define (refuse w reason) (assoc-in w (list :refusals) (insert-sorted reason (refused w) string<?)))
(define (witness name reason)
  (property name (w) (not (member reason (refused w)))))
