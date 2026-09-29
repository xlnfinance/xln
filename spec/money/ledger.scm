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

(define ledger (dict :init init :next next :invariants invariants :at-rest (list)))
