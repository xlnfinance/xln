;; Planted bug: only neighbouring repeats count (1, 1 reverts; 1, 2, 1 does not); the contract reverts on any repeated token (E2).
(define (repeated? ids)
  (let loop ((l ids)) (cond ((or (null? l) (null? (cdr l))) #f) ((= (car l) (cadr l)) #t) (else (loop (cdr l))))))
