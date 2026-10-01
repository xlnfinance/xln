;; A two-party swap inside one Account: a description, not an implementation.
;;
;; The maker OFFERS `give` of one token for `want` of another; the other side, the taker, FILLS a ratio r of the
;; remainder (a whole number of 65535ths); the maker may WITHDRAW what is left; anyone may LAPSE an offer once the
;; deciding party's view is strictly past `deadline + reserve`. A DISPUTE settles the signed body, which carries one
;; swap clause per open offer, and the taker chooses a ratio for each clause on chain.
;;
;; Sources: plan/swap-onchain.md (the stock DeltaTransformer swap clause: uint16 ratio of 65535, each leg is
;; floor(amount * r / 65535) on its own, a clause with no allowance on a leg reverts the finalize, the contract keeps
;; no memory of fills, no expiry on chain) and plan/contracts-decisions.md "Swap inside an Account" (R-SWAP-*).
;; The kernel is PR #111 (txs offer, fill, retract, lapse; here `withdraw` is its retract).
;;
;; What the page says:
;;   R-SWAP-OFFER   an offer RESERVES the maker's give (against the maker, in its token) and the taker's want
;;                  (against the taker, in the other token); RCPAN counts the reservations as held, so a fill never
;;                  fails on funds. An offer is kept only if RCPAN still holds with it.
;;   R-SWAP-FILL    only the taker fills, a ratio 1..65535 of what REMAINS, while the offer is open and not past its
;;                  deadline. Each leg is floor(remainder * r / 65535) on its own; a fill that takes nothing of a leg
;;                  is refused; 65535 takes the rest and drops the offer. The fill moves the offdeltas by the legs.
;;   R-SWAP-CLAUSE-WITH-FILL  the contract has no memory of fills. The step that moves the offdeltas therefore
;;                  shrinks the signed clause to the remainder (drops it on a whole fill) in the SAME step. A clause
;;                  left at the old amounts lets a dispute fill the same amount again.
;;   R-SWAP-ALLOWANCES  the clause carries an allowance on both legs, sized to the remainder. A clause with no
;;                  allowance on a leg makes the chain's finalize revert, so no dispute can settle.
;;   R-SWAP-WITHDRAW  only the maker, at any time; the remainder's reservations go, what was filled stays, and a
;;                  withdrawn offer never changes again.
;;   R-SWAP-EXPIRE  the chain has no expiry. An offer lapses by a frame once now is strictly past deadline +
;;                  reserve (the R-HTLC-CLOCK rule); until then the signed clause is live. A lapsed offer never
;;                  changes again.
;;   R-SWAP-ONCHAIN  the dispute: the chain settles the body's offdeltas plus, for each clause, the taker's ratio of
;;                  its amounts, floor on each leg; ratio 0 fills nothing.
;;
;; The world keeps two descriptions of every offer on purpose. `:book` is the Account's record of an offer (what it
;; gave and wanted, what was filled); `:clauses` is the swap clause of the signed body (what a dispute would fill).
;; A rule moves them together, and the properties read them separately.
;;
;; Not modelled: more than two tokens (the Account has two, one pair), the hub book, loans, HTLC clauses (the only
;; holds are offers), several offers per slot, the clamp of an allowance below the fill (here an allowance is the
;; remainder, so it never bites), the n-th ratio of several swaps in one clause, the starter's committed ratio, a
;; stale proof (the dispute page's counter answers it), and the Runtime duties: when to lapse, retract before a
;; dispute, the taker's choice of ratio, R-SIGNED-IS-LIVE for the fill's frame (the older proof with the larger
;; clause stays enforceable until the fill's frame commits; a fill is only as final as its frame).
;;
;; Needs lib/vocabulary.scm, lib/check.scm and money/core.scm.

;; ---- model bounds
(define/overridable collateral    (s/number) 3)   ; per token; Left owns token :a, Right owns token :b
(define/overridable credit-left   (s/number) 1)   ; credit extended TO Left, per token (Q-L-1)
(define/overridable credit-right  (s/number) 1)
(define/overridable max-now       (s/number) 3)   ; J height of the clock
(define/overridable max-offer-now (s/number) 0)   ; an offer is made at a height up to this one
(define/overridable offer-span    (s/number) 1)   ; its deadline is that far ahead
(define/overridable lapse-reserve (s/number) 1)   ; R-HTLC-CLOCK: lapse needs now > deadline + reserve
(define/overridable max-pays      (s/number) 1)   ; payments of 1, to put RCPAN against the reservations

;; ---- the domain
(define sides (list :left :right))
(define (peer side) (if (equal? side :left) :right :left))
(define tokens (list :a :b))
(define max-ratio 65535)
;; the offers the model may make, one slot each: Left offers 3 of :a for 2 of :b, Right offers 2 of :b for 1 of :a.
;; Both together just fit: Left's holds on :a are 3 + 1 and the credit Right extended is 1, and the mirror on :b.
(define menu
  (list (dict :id "o1" :maker :left  :gt :a :give 3 :wt :b :want 2)
        (dict :id "o2" :maker :right :gt :b :give 2 :wt :a :want 1)))
(define indexes (let up ((i 0)) (if (< i (length menu)) (cons i (up (+ i 1))) (list))))
;; the ratios the taker may pick (the bug files widen them), and the ones it may pick on chain in a dispute
(define taker-ratios (list 1 32768 65535))
(define dispute-ratios (list 0 32768 65535))

(define (menu-ref i) (list-ref menu i))
(define (maker-of i) (:maker (menu-ref i)))
(define (taker-of i) (peer (maker-of i)))
(define (offer-index id) (find (lambda (i) (equal? (:id (menu-ref i)) id)) indexes))
(define (set-nth lst i v) (append (take lst i) (list v) (list-tail lst (+ i 1))))

;; The OFFER RECORD of the Account: (status deadline filled-give filled-want), #f before the offer exists.
;; The amounts offered are in the menu; the remainder is what is left of them.
(define (book-of w i) (list-ref (:book w) i))
(define (open? o) (and o (equal? (:status o) :open)))
(define (rem-give i o) (- (:give (menu-ref i)) (:fg o)))
(define (rem-want i o) (- (:want (menu-ref i)) (:fw o)))

;; the SWAP CLAUSE of the signed body: the amounts it can still fill and the allowance it carries on each leg
;; (#f: no allowance, the chain's finalize reverts). Built from the remainder.
(define (clause-for i o)
  (and (open? o) (dict :give (rem-give i o) :want (rem-want i o) :allow-give (rem-give i o) :allow-want (rem-want i o))))

;; ---- holds (Ledger.reserved): per token, per side, what the open offers could still take from it
(define (hold-of held tok side) (get-in held (list tok side)))
(define (add-hold held tok side n) (update-in held (list tok side) (lambda (x) (+ x n))))
;; sign 1 reserves, -1 releases: the maker's give in its token, the taker's want in the other token
(define (reserve-offer held i give want sign)
  (let ((m (menu-ref i)))
    (-> held (add-hold (:gt m) (maker-of i) (* sign give)) (add-hold (:wt m) (taker-of i) (* sign want)))))

;; RCPAN on both tokens with the given holds counted as locked (money/core.scm)
(define (rcpan-ok? off held)
  (every (lambda (tok)
           (ledger-rcpan-ok? (get-in off (list tok)) (hold-of held tok :left) (hold-of held tok :right)
                             collateral credit-left credit-right))
         tokens))

(define init
  (dict :now 0
        :off (dict :a collateral :b 0)        ; Δ per token: Left's allocation
        :pays (dict :a collateral :b 0)       ; what payments alone made of it (a ghost: no rule reads it)
        :held (dict :a (dict :left 0 :right 0) :b (dict :left 0 :right 0))
        :book (map (lambda (m) #f) menu)
        :clauses (map (lambda (m) #f) menu)
        :pay-count 0
        :settled #f))

(define (settled? w) (and (:settled w) #t))
(define (set-offer w i o c)
  (-> w (update-in (list :book) (lambda (b) (set-nth b i o)))
        (update-in (list :clauses) (lambda (cs) (set-nth cs i c)))))

;; ---- offer
(define (offer-enabled? w side i)
  (let ((m (menu-ref i)))
    (and (equal? side (maker-of i)) (not (book-of w i)) (<= (:now w) max-offer-now)
         (rcpan-ok? (:off w) (reserve-offer (:held w) i (:give m) (:want m) 1)))))
(define (offer-step w i)
  (let* ((m (menu-ref i))
         (o (dict :status :open :deadline (+ (:now w) offer-span) :fg 0 :fw 0)))
    (-> (set-offer w i o (clause-for i o))
        (update-in (list :held) (lambda (h) (reserve-offer h i (:give m) (:want m) 1))))))

;; ---- fill
;; R-SWAP-FILL: DeltaTransformer's WideMath.fill, which is floor(amount * r / 65535)
(define (fill-leg amount r) (quotient (* amount r) max-ratio))
(define (fill-amounts i o r) (list (fill-leg (rem-give i o) r) (fill-leg (rem-want i o) r)))
(define (ratio-valid? r) (and (>= r 1) (<= r max-ratio)))
(define (takes-something? i o r) (every (lambda (leg) (> leg 0)) (fill-amounts i o r)))
;; the offer is live in the judge's view: open, and not past its deadline
(define (fillable? w o) (and (open? o) (<= (:now w) (:deadline o))))
(define (fill-enabled? w side i r)
  (let ((o (book-of w i)))
    (and o (equal? side (taker-of i)) (fillable? w o) (ratio-valid? r) (takes-something? i o r))))
(define (after-fill i o gl wl)
  (let ((fg (+ (:fg o) gl)) (fw (+ (:fw o) wl)) (m (menu-ref i)))
    (dict :status (if (and (>= fg (:give m)) (>= fw (:want m))) :filled :open) :deadline (:deadline o) :fg fg :fw fw)))
;; R-SWAP-CLAUSE-WITH-FILL: the clause of the frame that folds the fill is the remainder, or none (bug `swap-fill-leaves-clause`)
(define (clause-after-fill w i o2) (clause-for i o2))
(define (fill-step w i r)
  (let* ((m (menu-ref i)) (o (book-of w i)) (legs (fill-amounts i o r)) (gl (car legs)) (wl (cadr legs)) (o2 (after-fill i o gl wl)))
    (-> (set-offer w i o2 (clause-after-fill w i o2))
        (update-in (list :off (:gt m)) (lambda (x) (ledger-pay x (maker-of i) gl)))
        (update-in (list :off (:wt m)) (lambda (x) (ledger-pay x (taker-of i) wl)))
        (update-in (list :held) (lambda (h) (reserve-offer h i gl wl -1))))))

;; ---- withdraw and lapse: the remainder's reservations go, the clause goes, what was filled stays
(define (withdraw-returns i o) (list (rem-give i o) (rem-want i o)))
(define (lapse-returns i o) (list (rem-give i o) (rem-want i o)))
(define (close-step w i status returns)
  (let ((o (book-of w i)))
    (-> (set-offer w i (assoc-in o (list :status) status) #f)
        (update-in (list :held) (lambda (h) (reserve-offer h i (car returns) (cadr returns) -1))))))
(define (withdraw-enabled? w side i) (and (equal? side (maker-of i)) (open? (book-of w i))))
(define (withdraw-step w i) (close-step w i :withdrawn (withdraw-returns i (book-of w i))))
;; R-SWAP-EXPIRE: strictly past deadline + reserve (bug `swap-lapse-early`)
(define (lapse-due? w o) (> (:now w) (+ (:deadline o) lapse-reserve)))
(define (lapse-enabled? w side i) (let ((o (book-of w i))) (and (open? o) (lapse-due? w o))))
(define (lapse-step w i) (close-step w i :lapsed (lapse-returns i (book-of w i))))

;; ---- a payment (the rules pay 1; `pay-fits?` answers for any amount): RCPAN with the reservations counted
(define (pay-fits? w side tok n)
  (rcpan-ok? (update-in (:off w) (list tok) (lambda (x) (ledger-pay x side n))) (:held w)))
(define (pay-enabled? w side tok) (and (< (:pay-count w) max-pays) (pay-fits? w side tok 1)))
(define (pay-step w side tok)
  (-> w (update-in (list :off tok) (lambda (x) (ledger-pay x side 1)))
        (update-in (list :pays tok) (lambda (x) (ledger-pay x side 1)))
        (update-in (list :pay-count) (lambda (n) (+ n 1)))))

;; ---- the dispute: the chain settles the signed body (the offdeltas and the clauses), the taker picks the ratio
;; DeltaTransformer.applySwap: floor(amount * r / 65535) on each leg (bug `swap-chain-leg-rounds-up`)
(define (chain-leg amount r) (quotient (* amount r) max-ratio))
;; the offdelta the chain starts from (bug `swap-dispute-drops-filled`)
(define (settle-base w tok) (get-in w (list :off tok)))
(define (no-allowance? c) (or (not (:allow-give c)) (not (:allow-want c))))
;; a clause that changes a delta it has no allowance for reverts the whole finalize
(define (finalize-reverts? w) (any (lambda (c) (and c (no-allowance? c))) (:clauses w)))
(define (clause-legs c r) (and c (list (chain-leg (:give c) r) (chain-leg (:want c) r))))
(define (legs-effect w tok legs)
  (apply + (map (lambda (i l)
                  (let ((m (menu-ref i)))
                    (if l
                        (+ (if (equal? (:gt m) tok) (ledger-pay 0 (maker-of i) (car l)) 0)
                           (if (equal? (:wt m) tok) (ledger-pay 0 (taker-of i) (cadr l)) 0))
                        0)))
                indexes legs)))
(define (dispute-enabled? w side r) (and (equal? side :left) (not (finalize-reverts? w))))
(define (dispute-step w r)
  (let ((legs (map (lambda (c) (clause-legs c r)) (:clauses w))))
    (assoc-in w (list :settled)
              (dict :ratio r :legs legs
                    :delta (dict :a (+ (settle-base w :a) (legs-effect w :a legs))
                                 :b (+ (settle-base w :b) (legs-effect w :b legs)))))))

;; ---- rules
(define (live-world? w) (not (settled? w)))
(define (offer-rule i)
  (rule (str "offer " (:id (menu-ref i))) (w side)
    (when (and (live-world? w) (offer-enabled? w side i)))
    (then (offer-step w i))))
(define (fill-rule i r)
  (rule (str "fill " (:id (menu-ref i)) " " r) (w side)
    (when (and (live-world? w) (fill-enabled? w side i r)))
    (then (fill-step w i r))))
(define (withdraw-rule i)
  (rule (str "withdraw " (:id (menu-ref i))) (w side)
    (when (and (live-world? w) (withdraw-enabled? w side i)))
    (then (withdraw-step w i))))
(define (lapse-rule i)
  (rule (str "lapse " (:id (menu-ref i))) (w side)
    (when (and (live-world? w) (lapse-enabled? w side i)))
    (then (lapse-step w i))))
(define (pay-rule tok)
  (rule (str "pay " tok) (w side)
    (when (and (live-world? w) (pay-enabled? w side tok)))
    (then (pay-step w side tok))))
(define tick
  (rule "tick" (w side)
    (when (and (live-world? w) (equal? side :left) (< (:now w) max-now)))
    (then (update-in w (list :now) (lambda (n) (+ n 1))))))
(define (dispute-rule r)
  (rule (str "dispute " r) (w side)
    (when (and (live-world? w) (dispute-enabled? w side r)))
    (then (dispute-step w r))))

(define (rules)
  (append (map offer-rule indexes)
          (append-map (lambda (i) (map (lambda (r) (fill-rule i r)) taker-ratios)) indexes)
          (map withdraw-rule indexes)
          (map lapse-rule indexes)
          (map pay-rule tokens)
          (list tick)
          (map dispute-rule dispute-ratios)))
(define (next w) (successors (rules) sides w))

;; ---- properties: from the offers and the ghost, never through the guards or the reservation field
(define (offers-open w) (filter (lambda (i) (open? (book-of w i))) indexes))
(define (booked w) (filter (lambda (i) (book-of w i)) indexes))
;; what the open offers could still take from `side` in `tok`
(define (open-holds w tok side)
  (apply + (map (lambda (i)
                  (let ((m (menu-ref i)) (o (book-of w i)))
                    (+ (if (and (equal? (:gt m) tok) (equal? (maker-of i) side)) (rem-give i o) 0)
                       (if (and (equal? (:wt m) tok) (equal? (taker-of i) side)) (rem-want i o) 0))))
                (offers-open w))))
;; the offdelta the legs `(gives wants)` of each offer make in `tok`
(define (legs-delta w tok leg-of)
  (apply + (map (lambda (i)
                  (let ((m (menu-ref i)) (l (leg-of i)))
                    (+ (if (equal? (:gt m) tok) (ledger-pay 0 (maker-of i) (car l)) 0)
                       (if (equal? (:wt m) tok) (ledger-pay 0 (taker-of i) (cadr l)) 0))))
                (booked w))))
(define (filled-delta w tok)
  (legs-delta w tok (lambda (i) (list (:fg (book-of w i)) (:fw (book-of w i))))))
;; what a taker's ratio r takes of the remainders, from the Account's own record
(define (share a r) (quotient (* a r) 65535))
(define (still-delta w tok r)
  (apply + (map (lambda (i)
                  (let ((m (menu-ref i)) (o (book-of w i)))
                    (+ (if (equal? (:gt m) tok) (ledger-pay 0 (maker-of i) (share (rem-give i o) r)) 0)
                       (if (equal? (:wt m) tok) (ledger-pay 0 (taker-of i) (share (rem-want i o) r)) 0))))
                (offers-open w))))

(define invariants
  (list
   ;; a payment is refused exactly when RCPAN refuses it with the open offers alone counted as held (a closed
   ;; offer keeps no reservation); the formula is written out again from the offers and `ledger-rcpan-ok?`
   (property "R-SWAP-WITHDRAW: no payment is refused for a reservation that no open offer holds" (w)
     (every (lambda (side)
              (every (lambda (tok)
                       (every (lambda (n)
                                (let ((off (update-in (:off w) (list tok) (lambda (x) (ledger-pay x side n)))))
                                  (equal? (pay-fits? w side tok n)
                                          (every (lambda (t) (ledger-rcpan-ok? (get-in off (list t)) (open-holds w t :left) (open-holds w t :right)
                                                                               collateral credit-left credit-right))
                                                 tokens))))
                              (list 1 2 3)))
                     tokens))
            sides))
   (property "R-SWAP-OFFER: the reservations are exactly what the open offers could still take" (w)
     (every (lambda (tok) (and (= (hold-of (:held w) tok :left) (open-holds w tok :left))
                               (= (hold-of (:held w) tok :right) (open-holds w tok :right))))
            tokens))
   ;; credit holds in the worst case over the open offers, which count as held (written from the offers)
   (property "R-SWAP-OFFER: RCPAN holds in the worst case over the open offers: a fill never fails on funds" (w)
     (every (lambda (tok)
              (let ((d (get-in w (list :off tok))))
                (and (>= (- d (open-holds w tok :left)) (- credit-left))
                     (<= (+ d (open-holds w tok :right)) (+ collateral credit-right)))))
            tokens))
   (property "R-SWAP-FILL: the legs filled never exceed the legs offered" (w)
     (every (lambda (i) (let ((m (menu-ref i)) (o (book-of w i)))
                          (or (not o) (and (<= 0 (:fg o) (:give m)) (<= 0 (:fw o) (:want m))))))
            indexes))
   (property "R-SWAP-FILL: nothing is created or lost: the offdeltas hold exactly the payments and the legs filled" (w)
     (every (lambda (tok) (= (get-in w (list :off tok)) (+ (get-in w (list :pays tok)) (filled-delta w tok)))) tokens))
   ;; the hazard of plan/swap-onchain.md: a clause left at the old amounts fills again. The signed body carries
   ;; a clause for an offer exactly while it is open, and the legs the offdeltas already hold plus the legs the
   ;; clause could still take never exceed the offer.
   (property "R-SWAP-CLAUSE-WITH-FILL R-BOOK-CLAUSE-LOCKSTEP: the signed clause never fills what the offdeltas already hold (any order of offers, fills, withdrawals, lapses)" (w)
     (every (lambda (i)
              (let ((m (menu-ref i)) (o (book-of w i)) (c (list-ref (:clauses w) i)))
                (and (eq? (and c #t) (open? o))
                     (or (not c) (and (<= (+ (:fg o) (:give c)) (:give m)) (<= (+ (:fw o) (:want c)) (:want m)))))))
            indexes))
   (property "R-SWAP-ALLOWANCES: every clause allows both legs, in full, of what remains" (w)
     (every (lambda (c) (or (not c) (and (:allow-give c) (:allow-want c)
                                         (>= (:allow-give c) (:give c)) (>= (:allow-want c) (:want c)))))
            (:clauses w)))
   ;; the dispute: the chain's legs are floor on each leg of the clause (R-SWAP-ONCHAIN) and settle what was filled
   ;; (the offdeltas hold it) plus the taker's ratio of what remains, never more than the offer
   (property "R-SWAP-ONCHAIN: the chain fills each leg of a clause by floor(amount * ratio / 65535); ratio 0 fills nothing" (w)
     (or (not (settled? w))
         (let ((s (:settled w)))
           (every (lambda (c l) (or (not c) (and (= (car l) (share (:give c) (:ratio s))) (= (cadr l) (share (:want c) (:ratio s))))))
                  (:clauses w) (:legs s)))))
   (property "R-SWAP-CLAUSE-WITH-FILL R-BOOK-DISPUTE-HONORS: a dispute honours what was filled: each token settles at the payments, the legs filled and the taker's fill of the remainder" (w)
     (or (not (settled? w))
         (every (lambda (tok)
                  (= (get-in w (list :settled :delta tok))
                     (+ (get-in w (list :pays tok)) (filled-delta w tok) (still-delta w tok (get-in w (list :settled :ratio))))))
                tokens)))
   (property "R-SWAP-OFFER: after a dispute no side is past the credit the other extended: the reservations covered every fill" (w)
     (or (not (settled? w))
         (every (lambda (tok) (let ((d (get-in w (list :settled :delta tok))))
                                (and (>= d (- credit-left)) (<= d (+ collateral credit-right)))))
                tokens)))))

;; ---- step properties: what each rule DID. The name of a rule is its verb, the offer's id and, for a fill, the ratio.
(define (rule-is? verb rname) (string-prefix? verb rname))
(define (rule-offer rname) (offer-index (substring rname (+ (string-length (car (string-split rname " "))) 1) (+ (string-length (car (string-split rname " "))) 3))))
(define (fill-ratio rname) (string->number (substring rname 8 (string-length rname))))
(define (record-of w i) (book-of w i))
(define (moved-legs w w2 i) (list (- (:fg (book-of w2 i)) (:fg (book-of w i))) (- (:fw (book-of w2 i)) (:fw (book-of w i)))))

(define steps
  (list
   (step-property "R-SWAP-FILL: a fill takes a whole ratio from 1 to 65535" (w rname side w2)
     (or (not (rule-is? "fill" rname)) (let ((r (fill-ratio rname))) (and (integer? r) (>= r 1) (<= r 65535)))))
   (step-property "R-SWAP-FILL: a fill never takes more of a leg than remains" (w rname side w2)
     (or (not (rule-is? "fill" rname))
         (let* ((i (rule-offer rname)) (o (book-of w i)) (l (moved-legs w w2 i)))
           (and (<= (car l) (rem-give i o)) (<= (cadr l) (rem-want i o))))))
   (step-property "R-SWAP-FILL: each leg of a fill is floor(remainder * ratio / 65535), rounded down on its own" (w rname side w2)
     (or (not (rule-is? "fill" rname))
         (let* ((i (rule-offer rname)) (o (book-of w i)) (l (moved-legs w w2 i)) (r (fill-ratio rname)))
           (and (= (car l) (share (rem-give i o) r)) (= (cadr l) (share (rem-want i o) r))))))
   (step-property "R-SWAP-WITHDRAW: a withdrawn offer never changes again" (w rname side w2)
     (every (lambda (i) (or (not (book-of w i)) (not (equal? (:status (book-of w i)) :withdrawn)) (equal? (book-of w i) (book-of w2 i))))
            indexes))
   (step-property "R-SWAP-WITHDRAW: a withdraw returns at most the remainder and moves no offdelta" (w rname side w2)
     (or (not (rule-is? "withdraw" rname))
         (let* ((i (rule-offer rname)) (o (book-of w i)) (m (menu-ref i)))
           (and (equal? (:off w2) (:off w))
                (>= (hold-of (:held w2) (:gt m) (maker-of i)) (- (hold-of (:held w) (:gt m) (maker-of i)) (rem-give i o)))
                (>= (hold-of (:held w2) (:wt m) (taker-of i)) (- (hold-of (:held w) (:wt m) (taker-of i)) (rem-want i o)))))))
   (step-property "R-SWAP-EXPIRE: a lapsed offer never changes again" (w rname side w2)
     (every (lambda (i) (or (not (book-of w i)) (not (equal? (:status (book-of w i)) :lapsed)) (equal? (book-of w i) (book-of w2 i))))
            indexes))
   (step-property "R-SWAP-EXPIRE: an offer lapses only once now is strictly past deadline + reserve" (w rname side w2)
     (or (not (rule-is? "lapse" rname))
         (> (:now w) (+ (:deadline (book-of w (rule-offer rname))) lapse-reserve))))))

(define account-swap (dict :init init :next next :invariants invariants :steps steps :at-rest (list) :goal settled?))
