;; Planted bug: the Entity signs every payment whatever the reserve. With the deposit skipped (token paused) the
;; payment goes out unfunded, fails on chain and burns a nonce; it comes back and does it again.
(define (fundable w draft)
  (filter (lambda (op) (or (not (leg? op)) (deposit-signable? w))) draft))
