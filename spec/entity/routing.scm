;; A hub forwarding one HTLC: the payer A locks to the hub H until dIn, H locks onward to the payee
;; B until dOut. A description of the routing rules the coordinator decided (2026-09-29 18:10) and of
;; lessons R-P1, R-P2, R-P5; xln.ts has constants for the deltas (5085-5112) but no rule ties them to
;; the time a chain fact takes to be seen and acted on.
;;
;;   LAG   the time for a chain fact to be seen and acted on. A chain fact (B's on-chain reveal) is
;;         VISIBLE to H `lag` after it lands; H's own on-chain action is EFFECTIVE `lag` after H takes it.
;;   HOP   = 2 x LAG, a named POLICY parameter, not a protocol constant.
;;   R1    H forwards only if dOut <= dIn - HOP.
;;   R2    H fails the route back to A no earlier than dOut + LAG, and never while it can see a reveal:
;;         an on-chain reveal by B may still be in flight.
;;   N2    (coordinator 21:50) H refuses to forward a lock, and A refuses to sign one, whose deadline is beyond
;;         MAX_LOCK_HORIZON (`deadline_too_far`): under H1 a lock years out blocks close until the secret
;;         appears. A policy parameter, default 7 days on the real system, at least the 24 h async window.
;;   R3    a dispute H starts on the inbound Account publishes EVERY secret H knows for the payee locks.
;;
;; H is safe when B is paid by the outbound lock only if H is paid by the inbound lock. The adversary
;; picks B's reveal (off-chain to H, or on chain), whether A answers, and every timing. ASSUMPTION,
;; stated: H is DILIGENT, it acts in the tick in which it first sees the secret (the clock does not
;; advance while H has that duty). A negligent H can always lose; the rules must be enough for a
;; diligent one.
;;
;; Abstractions: one hop, one lock each way, amounts of 1, the money side is money/ledger.scm and the
;; dispute side is dispute/dispute.scm (a lock whose secret is public by its deadline pays; H1).
;;
;; Needs lib/vocabulary.scm and lib/check.scm.

(define/overridable lag      (s/number) 1)
(define/overridable d-in     (s/number) 5)
(define/overridable max-time (s/number) 7)
(define/overridable failback-wait (s/number) 1)
(define/overridable max-lock-horizon (s/number) 5)
(define (horizon-ok? d) (<= d max-lock-horizon))
(define (hop) (* 2 lag))

(define sides (list :hub))

(define init
  (dict :now 0 :forwarded #f :d-out #f :a-silent #f
        :b-reveal #f          ; #f, or (mode time): mode "off" (to H) or "chain"
        :h-public-at #f       ; when H's own on-chain publication of the secret is effective
        :claimed #f           ; when H's off-chain claim on the inbound lock landed
        :failed-back #f :dispute #f))

;; ---- what H can see
(define (b-mode w) (car (:b-reveal w)))
(define (b-time w) (cadr (:b-reveal w)))
(define (visible-secret? w)
  (and (:b-reveal w)
       (or (equal? (b-mode w) "off") (<= (+ (b-time w) lag) (:now w)))))

;; ---- R1 and R2 as guards
(define (hop-ok? d) (<= d (- d-in (hop))))
(define (failback-ok? w) (>= (:now w) (+ (:d-out w) failback-wait)))

(define (forward-with d)
  (rule (str "forward " d) (w side)
    (when (and (not (:forwarded w)) (= (:now w) 0) (>= d 1) (<= d d-in) (hop-ok? d)
               (horizon-ok? d-in) (horizon-ok? d)))
    (then (-> w (assoc-in (list :forwarded) #t) (assoc-in (list :d-out) d)))))

(define a-goes-silent
  (rule "A goes silent" (w side)
    (when (and (= (:now w) 0) (not (:a-silent w))))
    (then (assoc-in w (list :a-silent) #t))))

(define (b-reveals mode)
  (rule (str "B reveals " mode) (w side)
    (when (and (:forwarded w) (not (:b-reveal w)) (<= (:now w) (:d-out w))))
    (then (assoc-in w (list :b-reveal) (list mode (:now w))))))

(define claim-off-chain
  (rule "H claims off chain" (w side)
    (when (and (visible-secret? w) (not (:a-silent w)) (not (:claimed w)) (not (:failed-back w)) (<= (:now w) d-in)))
    (then (assoc-in w (list :claimed) (:now w)))))

(define reveal-on-chain
  (rule "H reveals on chain" (w side)
    (when (and (visible-secret? w) (not (:claimed w)) (not (:failed-back w)) (not (:h-public-at w))))
    (then (assoc-in w (list :h-public-at) (+ (:now w) lag)))))

;; R3: the start carries every secret H knows for the payee locks
(define (start-publishes w) (cond ((:h-public-at w) (:h-public-at w)) ((visible-secret? w) (+ (:now w) lag)) (else #f)))
(define start-dispute
  (rule "H starts a dispute on the inbound Account" (w side)
    (when (and (:forwarded w) (not (:dispute w)) (not (:claimed w)) (not (:failed-back w))))
    (then (-> w (assoc-in (list :dispute) (list (:now w) (visible-secret? w)))
                (assoc-in (list :h-public-at) (start-publishes w))))))

(define fail-back
  (rule "H fails the route back" (w side)
    (when (and (:forwarded w) (not (:claimed w)) (not (:h-public-at w)) (not (:failed-back w))
               (failback-ok? w) (not (visible-secret? w))))
    (then (assoc-in w (list :failed-back) #t))))

;; H's duty: it sees the secret and has neither claimed nor published nor given up
(define (h-on-duty? w)
  (and (visible-secret? w) (not (:claimed w)) (not (:h-public-at w)) (not (:failed-back w)) (<= (:now w) d-in)))
(define tick
  (rule "tick" (w side)
    (when (and (< (:now w) max-time) (not (h-on-duty? w))))
    (then (update-in w (list :now) (lambda (n) (+ n 1))))))

(define (next w)
  (successors (append (list a-goes-silent (b-reveals "off") (b-reveals "chain") claim-off-chain reveal-on-chain
                            start-dispute fail-back tick)
                      (map forward-with (iota d-in 1)))
              sides w))

;; ---- outcomes, at the end of time
(define (final? w) (>= (:now w) max-time))
(define (b-paid? w) (and (:forwarded w) (:b-reveal w) #t))
(define (h-paid? w)
  (and (not (:failed-back w))
       (or (and (:claimed w) #t)
           (and (:h-public-at w) (<= (:h-public-at w) d-in)))))
(define (loss? w) (and (final? w) (b-paid? w) (not (h-paid? w))))

(define invariants
  (list
   (property "H never pays B without being paid by A: a diligent hub cannot lose" (w) (not (loss? w)))
   (property "onward lock ends at least HOP before the inbound lock (R1)" (w)
     (or (not (:forwarded w)) (hop-ok? (:d-out w))))
   (property "no lock is forwarded whose deadline is beyond MAX_LOCK_HORIZON (N2, deadline_too_far)" (w)
     (or (not (:forwarded w)) (and (<= d-in max-lock-horizon) (<= (:d-out w) max-lock-horizon))))
   (property "a dispute start publishes every secret H knows (R3)" (w)
     (or (not (:dispute w)) (not (cadr (:dispute w))) (and (:h-public-at w) #t)))))

(define routing (dict :init init :next next :invariants invariants :at-rest (list)))
