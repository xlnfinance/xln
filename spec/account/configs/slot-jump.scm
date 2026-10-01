;; R-PROOF-NONCE-ABOVE-SIGNED, the door: a Byzantine peer sends a valid frame at a slot far beyond what an honest peer could reach. An honest
;; receiver refuses it (`bad_slot`, with its floor); without the door one frame moves the committed slot as far as the peer likes. Clock off.
(define left-txs  (vector "a"))
(define right-txs (vector "x"))
(define conflicts (vector))
(define max-clock 0)
(define max-jumps 1)
