;; The Entity frame: what one Entity height does with what arrived, over two Accounts and one
;; token. A description of pure/xln.ts `foldTxs` (26673-26746) and lessons R-E1, R-E2, R-E4, Q-E1.
;;
;; The frame is FOUR PHASES over ONE view of every Account:
;;   1. arrivals   peer acks and peer credits are applied first, whatever order they arrived in.
;;   2. hooks      a scheduled wake returns Account txs; they are queued before the frame's own txs.
;;   3. txs        each `pay` is checked against the Account's projected room and, if it fits,
;;                 STAGED into the Account's mempool at once (Q-E1: later guards in the same frame see it).
;;                 A tx that does not fit is refused with notice.
;;   4. proposals  each Account with staged txs and no pending frame proposes them: first the Accounts
;;                 touched in this frame, in FIRST-TOUCH order (R-E4), then the rest in ascending id.
;;
;; The room of an Account: cap + credits received - sent and acked - pending - staged. That single
;; number is RCPAN for one side (money/ledger.scm), counted over everything already in flight
;; (xln.ts `projectedHubCredit`, 17273).
;;
;; Abstractions: one Entity, two Accounts (:p, :q), payments of 1, the peer's Account frames are the
;; `ack` and `credit` inputs (their protocol is account/frames.scm), no consensus (entity/consensus.scm).
;;
;; Needs lib/vocabulary.scm and lib/check.scm.

(define/overridable cap        (s/number) 1)
(define/overridable max-frames (s/number) 2)
;; the inputs that arrive, each (kind account); they arrive in any order
(define/overridable inputs (s/array (s/array (s/string)))
  (list (list "pay" "q") (list "pay" "p") (list "wake" "q") (list "credit" "q")))

(define sides (list :entity))
(define account-ids (list :p :q))
(define (account-name s) (if (equal? s "p") :p :q))
(define (input-of row) (list (car row) (account-name (cadr row))))
(define (kind i) (car i))
(define (account-of i) (cadr i))
(define (arrival? i) (or (equal? (kind i) "ack") (equal? (kind i) "credit")))

(define (blank-account) (dict :out 0 :credit 0 :pending 0 :staged 0))
(define init
  (dict :p (blank-account) :q (blank-account)
        :later (map (lambda (row) (input-of (vector->list row))) (vector->list inputs)) :pool (list)
        :refused (list) :admitted (list) :frames (list) :count 0))

;; what an Account can still take: the cap and the credits received, less everything sent and
;; acked, in flight, and already staged
(define (room w a)
  (- (+ cap (get-in w (list a :credit)))
     (+ (get-in w (list a :out)) (get-in w (list a :pending)) (get-in w (list a :staged)))))

;; ---- phase 1: arrivals
(define (arrive w i)
  (let ((a (account-of i)))
    (if (equal? (kind i) "ack")
        (-> w (update-in (list a :out) (lambda (o) (+ o (get-in w (list a :pending)))))
              (assoc-in (list a :pending) 0))
        (update-in w (list a :credit) (lambda (c) (+ c 1))))))

;; ---- phases 2 and 3: a tx is admitted against the view that already holds everything staged
(define (admit w i)
  (let ((a (account-of i)))
    (if (>= (room w a) 1)
        (-> w (update-in (list a :staged) (lambda (s) (+ s 1)))
              (update-in (list :admitted) (lambda (l) (append l (list i)))))
        (update-in w (list :refused) (lambda (l) (append l (list i)))))))

(define (fold-inputs f w is) (reduce (lambda (i acc) (f acc i)) w is))
(define (arrivals is) (filter arrival? is))
(define (hooks is) (filter (lambda (i) (equal? (kind i) "wake")) is))
(define (txs is) (filter (lambda (i) (equal? (kind i) "pay")) is))

;; ---- phase 4: proposals, first-touch order then ascending id
(define (first-touch is)
  (reduce (lambda (i acc) (if (member (account-of i) acc) acc (append acc (list (account-of i))))) (list) is))
(define (eligible? w a) (and (= (get-in w (list a :pending)) 0) (> (get-in w (list a :staged)) 0)))
(define (propose-order w touched)
  (append (filter (lambda (a) (eligible? w a)) touched)
          (filter (lambda (a) (and (not (member a touched)) (eligible? w a))) account-ids)))
(define (propose w a)
  (-> w (assoc-in (list a :pending) (get-in w (list a :staged))) (assoc-in (list a :staged) 0)))

;; the frame: the pool folded in four phases, and a record of what it did
(define (frame-fold w pool)
  (let* ((w1 (fold-inputs arrive w (arrivals pool)))
         (before (length (:admitted w1)))
         (w2 (fold-inputs admit w1 (append (hooks pool) (txs pool))))
         (admitted (list-tail (:admitted w2) before))
         (touched (first-touch admitted))
         (order (propose-order w2 touched))
         (w3 (fold-inputs propose w2 order)))
    (-> w3 (assoc-in (list :pool) (list))
           (update-in (list :count) (lambda (n) (+ n 1)))
           (update-in (list :frames) (lambda (fs) (cons (dict :admitted admitted :touched touched :proposed order) fs))))))

;; ---- rules
(define (arrive-nth i)
  (rule (str "arrive " i) (w side)
    (when (< i (length (:later w))))
    (then (let ((input (list-ref (:later w) i)))
            (-> w (assoc-in (list :later) (append (take (:later w) i) (list-tail (:later w) (+ i 1))))
                  (update-in (list :pool) (lambda (p) (append p (list input)))))))))

(define frame
  (rule "frame" (w side)
    (when (and (pair? (:pool w)) (< (:count w) max-frames)))
    (then (frame-fold w (:pool w)))))

;; the peer acknowledges an Account frame in flight
(define (peer-ack a)
  (rule (str "ack " a) (w side)
    (when (and (> (get-in w (list a :pending)) 0) (not (member (list "ack" a) (:pool w)))))
    (then (update-in w (list :pool) (lambda (p) (append p (list (list "ack" a))))))))

(define (rules-for w)
  (append (list frame) (map peer-ack account-ids) (map arrive-nth (iota (length (:later w))))))
(define (next w) (successors (rules-for w) sides w))

;; ---- properties
(define (in-flight w a) (+ (get-in w (list a :out)) (get-in w (list a :pending)) (get-in w (list a :staged))))
(define (admitted-for w a) (length (filter (lambda (i) (equal? (account-of i) a)) (:admitted w))))
(define (ascending? as) (or (null? as) (null? (cdr as)) (and (equal? (car as) :p) (equal? (cadr as) :q))))
(define (hooks-first? kinds)
  (or (null? kinds) (and (not (and (equal? (car kinds) "pay") (member "wake" (cdr kinds)))) (hooks-first? (cdr kinds)))))

(define invariants
  (list
   (property "credit holds: nothing sent, in flight or staged exceeds the cap and the credits received" (w)
     (every (lambda (a) (<= (in-flight w a) (+ cap (get-in w (list a :credit))))) account-ids))
   (property "no tx is lost: every admitted tx is sent, in flight or staged; every other was refused with notice" (w)
     (every (lambda (a) (= (in-flight w a) (admitted-for w a))) account-ids))
   (property "hooks are queued before the frame's own txs (R-E2)" (w)
     (every (lambda (f) (hooks-first? (map kind (:admitted f)))) (:frames w)))
   (property "Accounts propose in first-touch order, then the rest by id (R-E4)" (w)
     (every (lambda (f)
              (let* ((firsts (filter (lambda (a) (member a (:proposed f))) (:touched f)))
                     (n (length firsts)))
                (and (equal? firsts (take (:proposed f) n)) (ascending? (list-tail (:proposed f) n)))))
            (:frames w)))
   ;; the frame folds the pool as (arrivals, hooks, txs); the same pool with its arrivals moved to
   ;; the end must fold to the same world
   (property "a frame's outcome does not depend on where its arrivals sit among its txs (R-E1)" (w)
     (or (null? (:pool w))
         (equal? (canon (frame-fold w (:pool w)))
                 (canon (frame-fold w (append (filter (lambda (i) (not (arrival? i))) (:pool w))
                                              (arrivals (:pool w))))))))))

;; finished: every input was folded, or the model's frame budget is spent
(define (finished? w) (or (>= (:count w) max-frames) (and (null? (:later w)) (null? (:pool w)))))
(define entity-frame (dict :init init :next next :invariants invariants :at-rest (list) :goal finished?))
