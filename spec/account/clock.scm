;; A frame's timestamp carries no authority (coordinator R-CLOCK, 21:56). A description of the rule the
;; Account frames follow when time enters a decision.
;;
;; Why: a late frame deadlocked an Account (a signed frame refused for its age has no exit: the
;; proposer holds it, resends the same signed frame and it is refused again), and a future-dated frame
;; let a payer expire a lock before the payee's own deadline (the receiver took the proposer's stamp
;; for the time).
;;
;; The rule, in two parts:
;;   1. No frame is refused for its age or its future date. Whatever a proposer stamps, the receiver
;;      decides the frame on its content.
;;   2. Every time-based decision (a lock expires, a deadline passed, the N2 horizon) is taken on the
;;      DECIDING party's own clock plus a named reserve (`clock-reserve`), never on a timestamp a
;;      counterparty wrote.
;;
;; The page: two parties with their own clocks (they only tick, and drift apart freely). Left is the
;; payer of one lock whose deadline is `lock-deadline`; Right is the payee. Left proposes a pay frame,
;; then a frame that expires the lock. A frame carries a stamp: any value, since a skewed or Byzantine
;; proposer stamps what it likes. The frame may reach Right after any delay (its clock keeps ticking).
;;   pay frame     Right commits it whatever its stamp says.
;;   expire frame  Right commits it only when ITS OWN clock has passed the deadline plus the reserve;
;;                 otherwise it refuses on content (a nack) and Left may propose again later.
;;
;; The secret resolve (coordinator #57, 01:11): a resolve frame reveals the secret to the payer. The payee
;; (Right) proposes it and stamps what it likes, including a claimed J height. The payer (Left) decides it
;; by the J height the payer itself has seen (`:jh`, the chain's own clock, which both parties can read),
;; never by the frame's stamp: a resolve is late only when the chain passed the resolve deadline.
;;   resolve frame  Left commits it while the chain height is within `resolve-deadline`, whatever the stamp
;;                  says; a later one is refused (the lock expires instead).
;;
;; Not modelled: hashes and acks (a frame commits when Right decides it), several frames, several locks,
;; the payee's side of the deadline (a claim before the deadline on its own clock), J height deadlines
;; (the same rule with the J clock). Needs lib/vocabulary.scm and lib/check.scm.

(define/overridable lock-deadline (s/number) 2)
(define/overridable clock-reserve (s/number) 1)
(define/overridable max-clock     (s/number) 3)
(define/overridable max-stamp     (s/number) 3)
(define/overridable resolve-deadline (s/number) 1)   ; a J height
(define/overridable max-jh        (s/number) 2)
;; only the planted bugs use these two: the age and the skew a receiver would tolerate
(define/overridable max-age  (s/number) 1)
(define/overridable max-skew (s/number) 1)

(define sides (list :left :right))
(define init
  (dict :now (dict :left 0 :right 0)
        :pending #f                 ; #f, or (dict :kind :pay | :expire, :stamp n)
        :committed (list)           ; the kinds committed, oldest first
        :expired-at #f              ; Right's own clock when the expire frame committed
        :jh 0                       ; the chain height both parties can read
        :resolve-pending #f         ; #f, or the stamp of a resolve frame in flight to Left
        :resolve-refusals (list)    ; (dict :jh n :stamp s) for every resolve Left refused
        :stamp-refusals (list)))    ; the stamps of frames refused for their timestamp

(define (own-now w side) (get-in w (list :now side)))

;; ---- the two decisions, as functions the planted bugs redefine
;; part 1: correct = never refuse on the timestamp
(define (refused-for-stamp? w stamp) #f)
;; part 2: correct = the receiver's own clock, plus the reserve
(define (lock-expired? w stamp) (>= (own-now w :right) (+ lock-deadline clock-reserve)))

;; part 3: a resolve is late by J height alone, never by the frame's stamp
(define (resolve-late? w stamp) (> (:jh w) resolve-deadline))

;; ---- rules
(define tick-jh
  (rule "chain height ticks" (w side)
    (when (< (:jh w) max-jh))
    (then (update-in w (list :jh) (lambda (n) (+ n 1))))))

(define (propose-resolve stamp)
  (rule (str "Right proposes a resolve stamped " stamp) (w side)
    (when (and (equal? side :right) (equal? (:committed w) (list :pay)) (not (:resolve-pending w))))
    (then (assoc-in w (list :resolve-pending) stamp))))

(define deliver-resolve
  (rule "Left decides the resolve" (w side)
    (when (and (equal? side :left) (:resolve-pending w)))
    (then (let ((stamp (:resolve-pending w)))
            (cond ((not (equal? (:committed w) (list :pay))) (assoc-in w (list :resolve-pending) #f))
                  ((resolve-late? w stamp)
                   (-> (assoc-in w (list :resolve-pending) #f)
                       (update-in (list :resolve-refusals)
                                  (lambda (r) (let ((rec (dict :jh (:jh w) :stamp stamp))) (if (member rec r) r (append r (list rec))))))))
                  (else (-> (assoc-in w (list :resolve-pending) #f)
                            (update-in (list :committed) (lambda (c) (append c (list :resolve)))))))))))

(define tick
  (rule "tick" (w side)
    (when (< (own-now w side) max-clock))
    (then (update-in w (list :now side) (lambda (n) (+ n 1))))))

(define (propose-with kind stamp)
  (rule (str "propose " kind " stamped " stamp) (w side)
    (when (and (equal? side :left) (not (:pending w))
               (if (equal? kind :pay)
                   (null? (:committed w))
                   (and (equal? (:committed w) (list :pay)) (>= (own-now w :left) lock-deadline)))))
    (then (assoc-in w (list :pending) (dict :kind kind :stamp stamp)))))

(define (commit w kind)
  (-> w (update-in (list :committed) (lambda (c) (append c (list kind))))
        (assoc-in (list :pending) #f)
        (assoc-in (list :expired-at) (if (equal? kind :expire) (own-now w :right) (:expired-at w)))))
(define (refuse-for-stamp w stamp)
  (update-in w (list :stamp-refusals) (lambda (r) (if (member stamp r) r (append r (list stamp))))))

(define deliver
  (rule "deliver" (w side)
    (when (and (equal? side :right) (:pending w)))
    (then (let* ((f (:pending w)) (stamp (:stamp f)))
            (cond ((refused-for-stamp? w stamp) (refuse-for-stamp w stamp))   ; the frame stays pending
                  ((equal? (:kind f) :pay) (commit w :pay))
                  ((and (lock-expired? w stamp) (equal? (:committed w) (list :pay))) (commit w :expire))
                  (else (assoc-in w (list :pending) #f)))))))               ; refused on content: a nack

(define (rules-for w)
  (append (list tick tick-jh deliver deliver-resolve)
          (append-map (lambda (s) (list (propose-with :pay s) (propose-with :expire s)))
                      (iota (+ max-stamp 1)))
          ;; a resolve's stamp is either honest (0) or the latest one a proposer can write
          (list (propose-resolve 0) (propose-resolve max-stamp))))
(define (next w) (successors (rules-for w) sides w))

;; ---- properties
(define invariants
  (list
   (property "no frame is refused for its age or its future date: a signed frame has an exit (R-CLOCK)" (w)
     (null? (:stamp-refusals w)))
   (property "a lock is expired only after the payee's own clock passed its deadline plus the reserve (R-CLOCK)" (w)
     (or (not (:expired-at w)) (>= (:expired-at w) (+ lock-deadline clock-reserve))))
   (property "a secret resolve is late only by J height: a resolve delivered within the deadline is never refused whatever the frame stamp says (R-CLOCK, #57)" (w)
     (every (lambda (r) (> (:jh r) resolve-deadline)) (:resolve-refusals w)))))

;; done: the pay frame is committed, then the lock expired or its secret was resolved
(define (settled? w) (or (equal? (:committed w) (list :pay :expire)) (equal? (:committed w) (list :pay :resolve))))
(define account-clock (dict :init init :next next :invariants invariants :at-rest (list) :goal settled?))
