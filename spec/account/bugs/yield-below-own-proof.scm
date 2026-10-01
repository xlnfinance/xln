;; Planted bug (R-PROOF-NONCE-ABOVE-SIGNED, R-A1): the collision is decided by SIDE, not by slot: Left, with a frame out, keeps it and ignores
;; Right's whatever the slots, and Right yields to Left's. Right signs a retry at attempt 1 (slot 3) and meets Left's first frame (slot 2): it
;; yields and commits at a slot below the proof it signed, and Left ignores the frame that ranks above its own. Config right-expire.
(define (keeps-own? side r f) (and (:pending r) (equal? side :left)))
