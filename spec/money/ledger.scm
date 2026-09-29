;; The money layer of one Account and one token: a description, not an implementation.
;;
;; Δ = ondelta + offdelta is LEFT's allocation (Account.sol:1068; design/account-model.md §3).
;; The chain holds `collateral` and `ondelta`; the parties agree `offdelta` off-chain and keep
;; credit limits that the chain never sees (Depository.sol:949-956: signing an offdelta IS the
;; consent to it, the runtime enforces RCPAN before it signs).
;;
;;   RCPAN   -credit-left <= Δ <= collateral + credit-right,   in the WORST CASE over the
;;           outcomes of every open conditional clause (an HTLC that may or may not pay).
;;
;; Naming follows xln.ts (leftCreditLimit, rightCreditLimit): `credit-left` is the credit
;; EXTENDED TO Left, i.e. how far below zero Left's allocation may go; the side that extends it
;; is Right (see QUESTIONS.md Q-L-1).
;;
;; This page has no bilateral protocol (that is account/frames.scm) and no dispute (that is
;; dispute/dispute.scm). It defines the ledger transitions and the two properties every other
;; page relies on: credit holds, and money is conserved.
;;
;; Needs lib/vocabulary.scm and lib/check.scm.

;; ---- model bounds
(define/overridable start-reserve (s/number) 2)
(define/overridable max-credit    (s/number) 1)
(define/overridable max-clauses   (s/number) 2)

;; ---- the world (one token)
(define sides (list :left :right))
(define (peer side) (if (equal? side :left) :right :left))
(define init
  (dict :offdelta 0 :ondelta 0 :collateral 0
        :credit-left 0 :credit-right 0
        :clauses (list)
        :reserve (dict :left start-reserve :right start-reserve)))

(define (total-delta w) (+ (:ondelta w) (:offdelta w)))
(define (clause-sum w payer)
  (reduce (lambda (c acc) (if (equal? (:payer c) payer) (+ acc (:amount c)) acc)) 0 (:clauses w)))

;; the lowest and highest Δ any combination of clause outcomes can reach
(define (worst-low w)  (- (total-delta w) (clause-sum w :left)))
(define (worst-high w) (+ (total-delta w) (clause-sum w :right)))
(define (rcpan-ok? w)
  (and (>= (worst-low w) (- (:credit-left w)))
       (<= (worst-high w) (+ (:collateral w) (:credit-right w)))))

;; ---- transitions: each is a pure function world -> world, taken only when RCPAN still holds
(define (add-offdelta w payer amount)
  (update-in w (list :offdelta) (lambda (o) (if (equal? payer :left) (- o amount) (+ o amount)))))

(define (guarded name enabled? step)
  (rule name (w side)
    (when (and (enabled? w side) (rcpan-ok? (step w side))))
    (then (step w side))))

;; pay: the payer's allocation falls by `amount`
(define (pay-rule amount)
  (guarded (str "pay " amount) (lambda (w side) #t) (lambda (w side) (add-offdelta w side amount))))

;; set-credit: `side` extends `amount` of credit to its peer
(define (credit-key side) (if (equal? side :left) :credit-right :credit-left))
(define (credit-rule amount)
  (guarded (str "credit " amount)
           (lambda (w side) (and (<= amount max-credit) (not (= (get-in w (list (credit-key side))) amount))))
           (lambda (w side) (assoc-in w (list (credit-key side)) amount))))

;; lock: the payer commits `amount` to a conditional clause (an HTLC)
(define lock-rule
  (guarded "lock 1"
           (lambda (w side) (< (length (:clauses w)) max-clauses))
           (lambda (w side)
             (update-in w (list :clauses) (lambda (cs) (append cs (list (dict :payer side :amount 1))))))))

;; the clause at position `i` (owned by `side`, the payer) pays out, or lapses
(define (nth-clause w i) (list-ref (:clauses w) i))
(define (without-clause w i) (update-in w (list :clauses) (lambda (cs) (append (take cs i) (list-tail cs (+ i 1))))))
(define (clause-rule verb i pays?)
  (guarded (str verb " " i)
           (lambda (w side) (and (< i (length (:clauses w))) (equal? (:payer (nth-clause w i)) side)))
           (lambda (w side)
             (let ((c (nth-clause w i)))
               (if pays? (add-offdelta (without-clause w i) side (:amount c)) (without-clause w i))))))

;; cooperative collateral moves (R2C, C2R): `side` moves 1 between its reserve and the collateral.
;; A Left deposit raises ondelta with it: the deposit is Left's allocation (Account.sol:1251-1257).
(define (move-collateral w side amount)
  (-> w (update-in (list :collateral) (lambda (c) (+ c amount)))
        (update-in (list :ondelta) (lambda (o) (if (equal? side :left) (+ o amount) o)))
        (update-in (list :reserve side) (lambda (r) (- r amount)))))
(define r2c-rule
  (guarded "r2c 1" (lambda (w side) (>= (get-in w (list :reserve side)) 1)) (lambda (w side) (move-collateral w side 1))))
(define c2r-rule
  (guarded "c2r 1" (lambda (w side) (>= (:collateral w) 1)) (lambda (w side) (move-collateral w side -1))))

(define (rules)
  (list (pay-rule 1) (pay-rule 2) (credit-rule 0) (credit-rule 1) (credit-rule 2) lock-rule
        (clause-rule "resolve" 0 #t) (clause-rule "resolve" 1 #t)
        (clause-rule "expire" 0 #f) (clause-rule "expire" 1 #f)
        r2c-rule c2r-rule))
(define (next w) (successors (rules) sides w))

;; ---- properties
(define (total-value w) (+ (get-in w (list :reserve :left)) (get-in w (list :reserve :right)) (:collateral w)))

(define invariants
  (list
   ;; written out again from the formula, not through rcpan-ok?, so a wrong guard cannot hide itself
   (property "credit holds: RCPAN in the worst case over the open clauses" (w)
     (and (>= (- (total-delta w) (clause-sum w :left)) (- (:credit-left w)))
          (<= (+ (total-delta w) (clause-sum w :right)) (+ (:collateral w) (:credit-right w)))))
   (property "money is conserved: reserves + collateral never change" (w)
     (= (total-value w) (* 2 start-reserve)))
   (property "no reserve or collateral goes negative" (w)
     (and (>= (get-in w (list :reserve :left)) 0) (>= (get-in w (list :reserve :right)) 0) (>= (:collateral w) 0)))
   (property "every open clause is within the payer's capacity" (w)
     (and (<= (clause-sum w :left) (+ (total-delta w) (:credit-left w)))
          (<= (clause-sum w :right) (- (+ (:collateral w) (:credit-right w)) (total-delta w)))))))

;; ---- step properties: what each rule DID, from the formula and not from the page's helpers.
;; A world-only property cannot see a rule that moves the wrong amount in the wrong direction and
;; still lands on a world that satisfies RCPAN (the guard and the invariant are one formula).
(define (rule-is? prefix rname) (string-prefix? prefix rname))
(define (clause-count w) (length (:clauses w)))
(define (reserve-of w side) (get-in w (list :reserve side)))
(define (same-money? w w2)
  (and (= (reserve-of w :left) (reserve-of w2 :left)) (= (reserve-of w :right) (reserve-of w2 :right))
       (= (:collateral w) (:collateral w2))))
;; Left's allocation moves down when Left pays and up when Right pays
(define (payer-sign side) (if (equal? side :left) -1 1))
(define (rule-amount rname) (string->number (substring rname 4 5)))

(define steps
  (list
   (step-property "pay n: the payer's allocation falls by n; nothing else moves" (w rname side w2)
     (or (not (rule-is? "pay" rname))
         (and (= (total-delta w2) (+ (total-delta w) (* (payer-sign side) (rule-amount rname))))
              (same-money? w w2) (equal? (:clauses w) (:clauses w2)))))
   (step-property "lock: Δ and the money stay, one clause of the payer is added" (w rname side w2)
     (or (not (rule-is? "lock" rname))
         (and (= (total-delta w2) (total-delta w)) (same-money? w w2)
              (= (clause-count w2) (+ (clause-count w) 1))
              (equal? (:payer (list-ref (:clauses w2) (clause-count w))) side))))
   (step-property "resolve: the clause pays, Δ moves against its payer by its amount" (w rname side w2)
     (or (not (rule-is? "resolve" rname))
         (let ((c (list-ref (:clauses w) (string->number (substring rname 8 9)))))
           (and (= (total-delta w2) (+ (total-delta w) (* (payer-sign (:payer c)) (:amount c))))
                (same-money? w w2) (= (clause-count w2) (- (clause-count w) 1))))))
   (step-property "expire: the clause lapses, Δ and the money stay" (w rname side w2)
     (or (not (rule-is? "expire" rname))
         (and (= (total-delta w2) (total-delta w)) (same-money? w w2)
              (= (clause-count w2) (- (clause-count w) 1)))))
   (step-property "r2c / c2r: one unit between the payer's reserve and the collateral; a Left deposit is Left's allocation" (w rname side w2)
     (or (not (or (rule-is? "r2c" rname) (rule-is? "c2r" rname)))
         (let ((dir (if (rule-is? "r2c" rname) 1 -1)))
           (and (= (:collateral w2) (+ (:collateral w) dir))
                (= (reserve-of w2 side) (- (reserve-of w side) dir))
                (= (reserve-of w2 (peer side)) (reserve-of w (peer side)))
                (= (total-delta w2) (+ (total-delta w) (if (equal? side :left) dir 0)))))))
   (step-property "credit: only the credit limit changes" (w rname side w2)
     (or (not (rule-is? "credit" rname))
         (and (= (total-delta w2) (total-delta w)) (same-money? w w2) (equal? (:clauses w) (:clauses w2)))))))

(define ledger (dict :init init :next next :invariants invariants :steps steps :at-rest (list)))
