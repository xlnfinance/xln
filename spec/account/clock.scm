;; HTLC time in the Account layer: R-CLOCK (a frame's timestamp carries no authority) and R-HTLC-CLOCK (coordinator 09-30, Account comparison
;; D-AC-2, D-AC-3): every HTLC time judgment is made in J HEIGHT, never by an Account clock or a frame stamp.
;;
;; Why: a late frame deadlocked an Account (a signed frame refused for its age has no exit: the proposer holds it, resends the same signed frame
;; and it is refused again), and a future-dated frame let a payer expire a lock before the payee's own deadline (the receiver took the proposer's
;; stamp for the time).
;;
;; The rule:
;;   1. No frame is refused for its age or its future date (R-CLOCK). Whatever a proposer stamps, the receiver decides the frame on its content.
;;   2. Each party judges by its own VIEW of the J height, the `max(host.finalizedJHeight, ctx.jHeight)` door of R-CLOCK (here `:view`). A view lags the
;;      chain (`:jh`) by at most LAG, so the two views differ by at most LAG (`max-drift`, R-DRIFT).
;;   (a) A lock is live through its deadline height. The payer accepts a resolve while its own view is <= deadline, whatever the frame's stamp and
;;       whatever the chain height is. (This also closes xln.ts `htlc_timeout`: at jHeight == revealBeforeHeight the lock is still live.)
;;   (b) An expiry needs own view > deadline + reserve. The inequality is strict. It applies to the payer when it proposes and to the payee when it
;;       accepts. The reserve is in J heights and at least LAG (`clock-reserve`).
;;   (c) If the payee's resolve is still unacked when its own view reaches deadline - LAG, the payee reveals the secret on-chain (`payee-reveals`).
;;       Assumption (diligence, as on the other pages): a payee that owes the reveal does it before the chain moves on and before it decides an expire
;;       frame (`payee-duty?` blocks the chain tick and the expire frame's acceptance).
;;
;; The page: the chain height `:jh` and two views that only catch up (`view-tick`), bounded by LAG behind the chain. Left is the payer of one lock whose
;; deadline is `lock-deadline` (a J height); Right is the payee and holds the secret (`payee-knows-secret`). Left proposes a pay frame, then a frame that
;; expires the lock. A frame carries a stamp: any value, since a skewed or Byzantine proposer stamps what it likes. The frame may reach its receiver after
;; any delay (the chain keeps moving).
;;   pay frame     Right commits it whatever its stamp says.
;;   expire frame  Right commits it only when ITS OWN view is past deadline + reserve (strict); otherwise it refuses on content (a nack) and Left may
;;                 propose again later. Left may propose it at any time.
;;   resolve frame Right proposes it (any stamp, honest 0 or the latest one a proposer can write). Left commits it while ITS OWN view is <= deadline;
;;                 a later one is refused (the lock expires instead).
;;
;; Not modelled: hashes and acks (a frame commits when its receiver decides it), several frames, several locks, the on-chain dispute itself (the
;; dispute page has it), the views as a value that can stall, LAG other than the bound on the views. Needs lib/vocabulary.scm and lib/check.scm.

(define/overridable lock-deadline (s/number) 2)       ; a J height: the lock is live through it
(define/overridable lag           (s/number) 1)       ; a view lags the chain by at most this (LAG)
(define/overridable clock-reserve (s/number) 1)       ; J heights, at least LAG (R-HTLC-CLOCK b)
(define/overridable max-jh        (s/number) 4)
(define/overridable max-stamp     (s/number) 3)
(define/overridable payee-knows-secret (s/boolean) #t)
;; only the planted bugs use these two: the age and the skew a receiver would tolerate
(define/overridable max-age  (s/number) 1)
(define/overridable max-skew (s/number) 1)
(define max-drift lag)                                ; R-DRIFT: two views lag the chain by at most LAG, so they differ by at most LAG

(define sides (list :left :right))
(define init
  (dict :jh 0                   ; the chain height
        :view (dict :left 0 :right 0)   ; each party's own view of it
        :pending #f             ; #f, or (dict :kind :pay | :expire, :stamp n)
        :committed (list)       ; the kinds committed, oldest first
        :expired-views #f       ; both views when the expire frame committed
        :revealed #f            ; the payee put the secret on-chain
        :resolve-pending #f     ; #f, or the stamp of a resolve frame in flight to Left
        :resolve-refusals (list)    ; (dict :view n :stamp s) for every resolve Left refused, n = Left's own view
        :stamp-refusals (list)))    ; the stamps of frames refused for their timestamp

;; a party's own view of the J height
(define (own-now w side) (get-in w (list :view side)))

;; ---- the decisions, as functions the planted bugs redefine
;; part 1: correct = never refuse on the timestamp
(define (refused-for-stamp? w stamp) #f)
;; (b): correct = the receiver's own view, strictly past the deadline plus the reserve
(define (lock-expired? w stamp) (> (own-now w :right) (+ lock-deadline clock-reserve)))
;; (a): a resolve is late only when the payer's OWN view is past the deadline: never by the stamp, never by the chain height
(define (resolve-late? w stamp) (> (own-now w :left) lock-deadline))
;; (c): the payee owes the on-chain reveal when it holds the secret, its resolve is not committed, and its view reached deadline - LAG
(define (payee-duty? w)
  (and payee-knows-secret (equal? (:committed w) (list :pay)) (not (:revealed w))
       (>= (own-now w :right) (- lock-deadline lag))))

;; ---- rules
;; the chain moves on only when both views are within LAG of the new height, and a payee that owes the reveal acts first
(define tick-chain
  (rule "chain height ticks" (w side)
    (when (and (equal? side :left) (< (:jh w) max-jh) (not (payee-duty? w))
               (every (lambda (s) (<= (- (+ (:jh w) 1) (own-now w s)) lag)) sides)))
    (then (update-in w (list :jh) (lambda (n) (+ n 1))))))

;; a view catches up by one height
(define view-tick
  (rule "view catches up" (w side)
    (when (< (own-now w side) (:jh w)))
    (then (update-in w (list :view side) (lambda (n) (+ n 1))))))

(define payee-reveals
  (rule "payee reveals the secret on-chain" (w side)
    (when (and (equal? side :right) payee-knows-secret (equal? (:committed w) (list :pay)) (not (:revealed w))
               (>= (own-now w :right) (- lock-deadline lag))))
    (then (assoc-in w (list :revealed) #t))))

(define (propose-resolve stamp)
  (rule (str "Right proposes a resolve stamped " stamp) (w side)
    (when (and (equal? side :right) payee-knows-secret (equal? (:committed w) (list :pay)) (not (:resolve-pending w))))
    (then (assoc-in w (list :resolve-pending) stamp))))

(define deliver-resolve
  (rule "Left decides the resolve" (w side)
    (when (and (equal? side :left) (:resolve-pending w)))
    (then (let ((stamp (:resolve-pending w)))
            (cond ((not (equal? (:committed w) (list :pay))) (assoc-in w (list :resolve-pending) #f))
                  ((resolve-late? w stamp)
                   (-> (assoc-in w (list :resolve-pending) #f)
                       (update-in (list :resolve-refusals)
                                  (lambda (r) (let ((rec (dict :view (own-now w :left) :stamp stamp))) (if (member rec r) r (append r (list rec))))))))
                  (else (-> (assoc-in w (list :resolve-pending) #f)
                            (update-in (list :committed) (lambda (c) (append c (list :resolve)))))))))))

(define (propose-with kind stamp)
  (rule (str "propose " kind " stamped " stamp) (w side)
    (when (and (equal? side :left) (not (:pending w))
               (if (equal? kind :pay)
                   (null? (:committed w))
                   (equal? (:committed w) (list :pay)))))            ; the payer may propose an expiry at any time: the receiver's check is the guard
    (then (assoc-in w (list :pending) (dict :kind kind :stamp stamp)))))

(define (commit w kind)
  (-> w (update-in (list :committed) (lambda (c) (append c (list kind))))
        (assoc-in (list :pending) #f)
        (assoc-in (list :expired-views) (if (equal? kind :expire) (dict :left (own-now w :left) :right (own-now w :right)) (:expired-views w)))))
(define (refuse-for-stamp w stamp)
  (update-in w (list :stamp-refusals) (lambda (r) (if (member stamp r) r (append r (list stamp))))))

(define deliver
  (rule "deliver" (w side)
    (when (and (equal? side :right) (:pending w)))
    (then (let* ((f (:pending w)) (stamp (:stamp f)))
            (cond ((refused-for-stamp? w stamp) (refuse-for-stamp w stamp))   ; the frame stays pending
                  ((equal? (:kind f) :pay) (commit w :pay))
                  ((and (lock-expired? w stamp) (equal? (:committed w) (list :pay)) (not (payee-duty? w))) (commit w :expire))
                  (else (assoc-in w (list :pending) #f)))))))               ; refused on content: a nack

(define (rules-for w)
  (append (list tick-chain view-tick payee-reveals deliver deliver-resolve)
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
   ;; the goal, stated on both parties and not through the guard `lock-expired?` (a property that restates its guard is by construction):
   ;; when an expiry commits, NEITHER party's view still shows the lock live (R-HTLC-CLOCK b, R-DRIFT)
   (property "an expiry commits only when both parties' views are strictly past the deadline (R-HTLC-CLOCK b)" (w)
     (or (not (:expired-views w))
         (and (> (:left (:expired-views w)) lock-deadline) (> (:right (:expired-views w)) lock-deadline))))
   (property "a resolve is refused only when the payer's own view is past the deadline: never by the frame stamp, never by the chain height (R-HTLC-CLOCK a)" (w)
     (every (lambda (r) (> (:view r) lock-deadline)) (:resolve-refusals w)))
   (property "a payee that holds the secret has revealed it on-chain before an expiry commits (R-HTLC-CLOCK c)" (w)
     (or (not (:expired-views w)) (not payee-knows-secret) (:revealed w)))))

;; done: the pay frame is committed, then the lock expired or its secret was resolved
(define (settled? w) (or (equal? (:committed w) (list :pay :expire)) (equal? (:committed w) (list :pay :resolve))))
(define account-clock (dict :init init :next next :invariants invariants :at-rest (list) :goal settled?))
