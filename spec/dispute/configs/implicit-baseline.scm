;; The alternative to co-signed baselines that Q-D-21 recommends. Loaded after two-disputes.scm. From the epoch after
;; an advance, the empty state (offdelta 0, no clause, one nonce above the chain nonce) is a valid proof for both
;; sides WITHOUT a signature, because every field of it is on chain. A second dispute then starts from it, and no
;; epoch advance leaves a side without a proof, however many disputes follow each other.
(define (implicit-proofs w)
  (if (> (:epoch w) 0) (list (list (+ (:chain-nonce w) 1) :left 0 #f #f (:epoch w))) (list)))
(define (held-by w side) (append (get-in w (list :held side)) (implicit-proofs w)))
