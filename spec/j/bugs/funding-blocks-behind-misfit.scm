;; Planted bug: the planner stops at the first payment that does not fit instead of skipping it, so a payment the reserve
;; covers waits behind one it does not, for ever.
(define (fundable w draft)
  (let loop ((rest draft) (avail (spendable w)) (acc (list)))
    (cond ((null? rest) acc)
          ((leg? (car rest)) (loop (cdr rest) avail (if (deposit-signable? w) (append acc (list (car rest))) acc)))
          ((r2c? (car rest))
           (if (>= avail (cost (car rest)))
               (loop (cdr rest) (- avail (cost (car rest))) (append acc (list (car rest))))
               acc))
          (else (loop (cdr rest) avail (append acc (list (car rest))))))))
