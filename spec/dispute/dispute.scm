;; One Account, one token: the dispute, from a stale start to the payout. A description, not an
;; implementation. It says what the FIXED contracts (contracts/, branch xkty13) do and what the
;; two parties may rely on.
;;
;; What each party holds off-chain is a set of PROOFS: a proof is a state (nonce, who proposed
;; it, offdelta, at most one HTLC clause) that the COUNTERPARTY signed. Only that signature makes
;; it presentable. A frame commits when the receiver signs, so the proposer holds the receiver's
;; signature one message later (`ack`): for a moment the proposer's newest proof is one behind.
;; A cross-open at one height leaves a second, losing proposal signed by Right (`rival`).
;;
;; On chain (Account.sol, Depository.sol; line numbers in QUESTIONS.md):
;;   start    any held proof of the CURRENT epoch and a nonce above the chain nonce. Freezes the
;;            windows; T = S + left + right (each window at least the floor: H2). No counterparty check.
;;   counter  only the NON-starter, only before T, only with a proof that ranks above the selected
;;            one. Rank = nonce, then Left's proposal over Right's at an equal nonce (R-A1).
;;   finalize 5a a counter is selected: at or after T, anyone.
;;            5c the initial proof stands: at or after T anyone; before T only the non-starter.
;;            5b no counter, the non-starter brings a higher-ranking proof and closes at once.
;;            An HTLC clause whose secret is not public waits for its deadline (H1).
;;   payout   Δ = ondelta + offdelta (+ the clause, if its secret was public by the deadline).
;;            Δ <= 0: Right takes the collateral and Left owes -Δ. 0 < Δ < c: Δ / c-Δ.
;;            Δ >= c: Left takes c and Right owes Δ-c. A shortfall is paid from the debtor's
;;            reserve first; the rest becomes debt. The epoch advances: every older proof dies
;;            (N1), so payments on the Account pause until a new baseline is co-signed.
;;
;; ASSUMPTION the safety properties stand on (stated, not hidden): the non-starter ACTS INSIDE ITS
;; WINDOW. The clock may not reach T while the non-starter holds a proof that outranks the selected
;; one and has not answered. Take it away (bug `no-floor`, windows of zero) and the properties fail.
;;
;; Not modelled here: Pull clauses (5b/5c wait for T when one is present), swaps, the watchtower
;; (it can only run a counter or an already selected finalize), several tokens (GAP-7), R2C during
;; a dispute (GAP-6), cooperative settlement. See QUESTIONS.md.
;;
;; Needs lib/vocabulary.scm and lib/check.scm.

;; ---- model bounds
(define/overridable window-left    (s/number) 1)
(define/overridable window-right   (s/number) 1)
(define/overridable min-window     (s/number) 1)
(define/overridable max-time       (s/number) 3)
(define/overridable htlc-deadline  (s/number) 1)
(define/overridable max-disputes   (s/number) 1)
(define/overridable credit-left    (s/number) 1)   ; credit extended TO Left (Q-L-1)
(define/overridable credit-right   (s/number) 1)
(define/overridable collateral0    (s/number) 2)
(define/overridable reserve-left0  (s/number) 1)
(define/overridable reserve-right0 (s/number) 0)

;; ---- the domain
(define sides (list :left :right))
(define (peer side) (if (equal? side :left) :right :left))
(define (windows) (list window-left window-right))
(define (window-floor-ok?) (every (lambda (x) (>= x min-window)) (windows)))

;; a state: who proposed it, offdelta, an optional HTLC clause. The clause is Left's payment to
;; Right of `amount`, paid out if the secret is public by `deadline`.
(define (state proposer off clause) (dict :proposer proposer :off off :clause clause))
(define (htlc amount deadline) (dict :amount amount :deadline deadline))

;; the agreed history, nonce 1, 2, 3 ...: Right pays Left 1; Left locks a 1-unit HTLC;
;; the lock is settled off-chain and Left ends up owing Right 1.
(define script (list (state :right 1 #f) (state :left 1 (htlc 1 htlc-deadline)) (state :right -1 #f)))
;; a losing proposal at one nonce: Right proposed at the same height as Left and lost the tie
(define rivals (list (dict :nonce 2 :state (state :right 3 #f))))

;; A proof is named by a string ("n2L": nonce 2, proposed by Left; a trailing ' marks a losing
;; proposal) and looked up in a fixed table. Worlds hold only names, which keeps them cheap to compare.
(define (side-letter side) (if (equal? side :left) "L" "R"))
(define (proof-entry nonce st rival?)
  (let ((id (str "n" nonce (side-letter (:proposer st)) (if rival? "'" ""))))
    (cons id (dict :nonce nonce :proposer (:proposer st) :off (:off st) :clause (:clause st) :rival rival?))))
(define proof-table
  (append (map (lambda (i) (proof-entry (+ i 1) (list-ref script i) #f)) (iota (length script)))
          (map (lambda (r) (proof-entry (:nonce r) (:state r) #t)) rivals)))
(define (proof-ref id) (cdr (assoc id proof-table)))
(define (p-nonce id) (:nonce (proof-ref id)))
(define (p-proposer id) (:proposer (proof-ref id)))
(define (p-off id) (:off (proof-ref id)))
(define (p-clause id) (:clause (proof-ref id)))
(define (p-rival? id) (:rival (proof-ref id)))
(define (rank id) (+ (* 2 (p-nonce id)) (if (equal? (p-proposer id) :left) 1 0)))
(define (id-at nonce rival?) (car (find (lambda (e) (and (= (:nonce (cdr e)) nonce) (equal? (:rival (cdr e)) rival?))) proof-table)))
(define (rival-at nonce) (find (lambda (r) (= (:nonce r) nonce)) rivals))

(define init
  (dict :epoch 0 :chain-nonce 0 :now 0
        :collateral collateral0 :ondelta 0
        :reserve (dict :left reserve-left0 :right reserve-right0)
        :debt (dict :left 0 :right 0)        ; owed BY the side to its peer
        :secret #f                           ; #f, or when the secret became public on chain
        :head 0                              ; off-chain height: how many script states were proposed
        :unacked #f                          ; the proof whose proposer still waits for the ack
        :held (dict :left (list) :right (list))
        :history-epoch 0                     ; the epoch every held proof was signed for
        :baselined 0                         ; the epoch a baseline was last co-signed for
        :dispute #f
        :results (list)))

;; ---- off-chain: propose, cross-open, ack
(define (script-left? w) (< (:head w) (length script)))
(define (next-state w) (list-ref script (:head w)))
(define (next-nonce w) (+ (:head w) 1))
(define (hold w side p) (update-in w (list :held side) (lambda (hs) (append hs (list p)))))
(define (frozen? w) (:dispute w))
(define (paused? w) (not (= (:baselined w) (:epoch w))))

(define (proposal-enabled? w)
  (and (script-left? w) (not (:unacked w)) (not (frozen? w)) (not (paused? w))))
(define (proposed w p) (-> w (assoc-in (list :unacked) p) (update-in (list :head) (lambda (h) (+ h 1)))))

(define propose
  (rule "propose" (w side)
    (when (and (proposal-enabled? w) (equal? (:proposer (next-state w)) side)))
    (then (let ((p (id-at (next-nonce w) #f)))
            (proposed (hold w (peer side) p) p)))))

;; a cross-open: Right proposed at the same height. Left's frame wins; Right signed its own, so
;; Left holds Right's losing proposal, Right holds Left's frame.
(define collide
  (rule "collide" (w side)
    (when (and (equal? side :left) (proposal-enabled? w)
               (equal? (:proposer (next-state w)) :left) (rival-at (next-nonce w))))
    (then (let ((p (id-at (next-nonce w) #f)))
            (proposed (-> w (hold :right p) (hold :left (id-at (next-nonce w) #t))) p)))))

;; the receiver's signature reaches the proposer
(define ack
  (rule "ack" (w side)
    (when (and (:unacked w) (equal? (p-proposer (:unacked w)) side)))
    (then (-> w (hold side (:unacked w)) (assoc-in (list :unacked) #f)))))

;; ---- the dispute
(define (selected d) (or (:counter d) (:initial d)))
(define (responder-of d) (peer (:starter d)))
(define (held-by w side) (get-in w (list :held side)))
(define (all-proofs w) (delete-duplicates (append (held-by w :left) (held-by w :right))))
(define (outranks? p q) (> (rank p) (rank q)))
(define (usable? w p) (and (= (:history-epoch w) (:epoch w)) (> (p-nonce p) (:chain-nonce w))))
(define (best-rank w side)
  (reduce (lambda (q acc) (max acc (if (usable? w q) (rank q) -1))) -1 (held-by w side)))

;; the honest non-starter answers before the clock reaches T
(define (responder-can-answer? w)
  (let ((d (:dispute w)))
    (and d (> (best-rank w (responder-of d)) (rank (selected d))))))
(define (blocked-by-response? w)
  (let ((d (:dispute w)))
    (and d (>= (+ (:now w) 1) (:timeout d)) (responder-can-answer? w))))

;; when the clock reaches T the responder's holdings are frozen for the record: a proof that
;; reaches it after the window closed (a late ack) is not one it could have used
(define (close-window w)
  (let ((d (:dispute w)))
    (if (and d (not (:closed-best d)) (>= (:now w) (:timeout d)))
        (assoc-in w (list :dispute :closed-best) (best-rank w (responder-of d)))
        w)))

;; ---- time and the public secret
(define tick
  (rule "tick" (w side)
    (when (and (equal? side :left) (< (:now w) max-time) (not (blocked-by-response? w))))
    (then (close-window (update-in w (list :now) (lambda (n) (+ n 1)))))))

(define reveal
  (rule "reveal" (w side)
    (when (and (equal? side :right) (not (:secret w)) (>= (:head w) 2)))
    (then (assoc-in w (list :secret) (:now w)))))

(define (start-with p)
  (rule (str "start " p) (w side)
    (when (and (not (:dispute w)) (< (length (:results w)) max-disputes)
               (member p (held-by w side)) (usable? w p) (window-floor-ok?)
               (<= (+ (:now w) (apply + (windows))) max-time)))
    (then (close-window
           (assoc-in w (list :dispute)
                     (dict :starter side :at (:now w) :timeout (+ (:now w) (apply + (windows)))
                           :initial p :counter #f :closed-best #f
                           :best-start? (= (rank p) (best-rank w side))))))))

(define (counter-with p)
  (rule (str "counter " p) (w side)
    (when (and (:dispute w) (equal? side (responder-of (:dispute w)))
               (member p (held-by w side)) (usable? w p)
               (< (:now w) (:timeout (:dispute w)))
               (outranks? p (selected (:dispute w)))))
    (then (assoc-in w (list :dispute :counter) p))))

;; ---- what the payout is worth
(define (secret-public-by? w deadline) (and (:secret w) (<= (:secret w) deadline)))
;; :none, :paid, :unpaid, or :wait (H1: unrevealed and the deadline has not passed)
(define (clause-outcome w p)
  (let ((c (p-clause p)))
    (cond ((not c) :none)
          ((secret-public-by? w (:deadline c)) :paid)
          ((<= (:now w) (:deadline c)) :wait)
          (else :unpaid))))
(define (final-delta w p outcome)
  (- (+ (:ondelta w) (p-off p)) (if (equal? outcome :paid) (:amount (p-clause p)) 0)))

(define (add-reserve w side amount) (update-in w (list :reserve side) (lambda (r) (+ r amount))))
;; a shortfall is paid from the debtor's reserve first; the rest becomes debt
(define (shortfall w debtor amount)
  (let ((pay (min amount (get-in w (list :reserve debtor)))))
    (-> w (add-reserve debtor (- pay)) (add-reserve (peer debtor) pay)
          (update-in (list :debt debtor) (lambda (d) (+ d (- amount pay)))))))
(define (payout w delta)
  (let ((c (:collateral w))
        (w0 (-> w (assoc-in (list :collateral) 0) (assoc-in (list :ondelta) 0))))
    (cond ((<= delta 0) (shortfall (add-reserve w0 :right c) :left (- delta)))
          ((< delta c)  (add-reserve (add-reserve w0 :left delta) :right (- c delta)))
          (else         (shortfall (add-reserve w0 :left c) :right (- delta c))))))

(define (adopted? d p) (not (equal? p (:initial d))))

;; what a side owns outside the collateral: reserve, less what it owes, plus what it is owed
(define (net w side)
  (- (+ (get-in w (list :reserve side)) (get-in w (list :debt (peer side)))) (get-in w (list :debt side))))

;; the record the properties read: what was decided, on what, and what each side owned before and after
(define (record w paid d p outcome path)
  (dict :proof p :path path :starter (:starter d) :delta (final-delta w p outcome)
        :outcome outcome :at (:now w) :epoch (:epoch w) :proof-epoch (:history-epoch w) :collateral (:collateral w)
        :best-start? (:best-start? d)
        :net-before-left (net w :left) :net-before-right (net w :right)
        :net-after-left (net paid :left) :net-after-right (net paid :right)
        :best-held (or (:closed-best d) (best-rank w (responder-of d)))))

(define (finalized w d p outcome path)
  (let ((paid (payout w (final-delta w p outcome))))
    (-> paid
        (assoc-in (list :dispute) #f)
        (update-in (list :epoch) (lambda (e) (+ e 1)))
        (assoc-in (list :chain-nonce) (if (adopted? d p) (p-nonce p) (+ (p-nonce (:initial d)) 1)))
        (assoc-in (list :head) (length script))
        (assoc-in (list :unacked) #f)
        (update-in (list :results) (lambda (rs) (cons (record w paid d p outcome path) rs))))))

;; 5a: a counter is selected and T has passed
(define finalize-counter
  (rule "finalize counter" (w side)
    (when (and (:dispute w) (:counter (:dispute w)) (>= (:now w) (:timeout (:dispute w)))
               (not (equal? (clause-outcome w (:counter (:dispute w))) :wait))))
    (then (let ((d (:dispute w)))
            (finalized w d (:counter d) (clause-outcome w (:counter d)) "5a")))))

;; 5c: the initial proof stands. After T anyone; before T only the non-starter, and an honest
;; one does not close on something worse than the best proof it holds.
(define finalize-initial
  (rule "finalize initial" (w side)
    (when (and (:dispute w) (not (:counter (:dispute w)))
               (or (>= (:now w) (:timeout (:dispute w)))
                   (and (equal? side (responder-of (:dispute w))) (not (responder-can-answer? w))))
               (not (equal? (clause-outcome w (:initial (:dispute w))) :wait))))
    (then (let ((d (:dispute w)))
            (finalized w d (:initial d) (clause-outcome w (:initial d)) "5c")))))

;; 5b: no counter is registered; the non-starter brings its best proof, which outranks the
;; initial one, and closes at once
(define (finalize-with p)
  (rule (str "finalize with " p) (w side)
    (when (and (:dispute w) (not (:counter (:dispute w))) (equal? side (responder-of (:dispute w)))
               (member p (held-by w side)) (usable? w p) (outranks? p (:initial (:dispute w)))
               (= (rank p) (best-rank w side))
               (not (equal? (clause-outcome w p) :wait))))
    (then (let ((d (:dispute w)))
            (finalized w d p (clause-outcome w p) "5b")))))

;; after a finalize the old proofs are dead (epoch); the parties co-sign a new baseline
(define rebaseline
  (rule "rebaseline" (w side)
    (when (and (equal? side :left) (paused? w) (not (:dispute w))))
    (then (assoc-in w (list :baselined) (:epoch w)))))

(define (rules-for w)
  (let ((ps (all-proofs w)))
    (append (list propose collide ack tick reveal finalize-counter finalize-initial rebaseline)
            (map start-with ps) (map counter-with ps) (map finalize-with ps))))
(define (next w) (successors (rules-for w) sides w))

;; ---- properties
(define (total-funds w)
  (+ (get-in w (list :reserve :left)) (get-in w (list :reserve :right)) (:collateral w)))

(define invariants
  (list
   ;; the four properties Arthur named
   (property "a dispute pays out what the selected state says: net left + Δ, net right + collateral - Δ" (w)
     (every (lambda (r)
              (and (= (:net-after-left r)  (+ (:net-before-left r)  (:delta r)))
                   (= (:net-after-right r) (+ (:net-before-right r) (- (:collateral r) (:delta r))))))
            (:results w)))
   (property "money is conserved: reserves + collateral never change" (w)
     (= (total-funds w) (+ collateral0 reserve-left0 reserve-right0)))
   (property "credit holds: what a side owes never exceeds the credit extended to it" (w)
     (and (<= (get-in w (list :debt :left)) credit-left)
          (<= (get-in w (list :debt :right)) credit-right)))
   (property "both sides sign the same proof: one body per nonce and proposer" (w)
     (let ((ps (all-proofs w)))
       (every (lambda (p) (every (lambda (q) (or (not (and (= (p-nonce p) (p-nonce q)) (equal? (p-proposer p) (p-proposer q))))
                                                 (equal? (proof-ref p) (proof-ref q))))
                                 ps))
              ps)))
   ;; what the parties may rely on
   (property "the responder is never worse off than the newest proof it held" (w)
     (every (lambda (r) (>= (rank (:proof r)) (:best-held r))) (:results w)))
   ;; a starter that starts with a stale proof is the one that pays for it; an honest starter is not
   (property "an honest starter never ends on a losing proposal" (w)
     (every (lambda (r) (or (not (:best-start? r)) (not (p-rival? (:proof r))))) (:results w)))
   (property "an HTLC is never settled as unpaid before its deadline" (w)
     (every (lambda (r) (or (not (equal? (:outcome r) :unpaid)) (> (:at r) (:deadline (p-clause (:proof r))))))
            (:results w)))
   (property "only a proof of the current epoch pays out" (w)
     (every (lambda (r) (= (:proof-epoch r) (:epoch r))) (:results w)))))

;; finished: a dispute was settled, or the model's clock has run out with none active (no window fits)
(define (settled? w)
  (or (pair? (:results w))
      (and (not (:dispute w)) (> (+ (:now w) (apply + (windows))) max-time))))
(define dispute (dict :init init :next next :invariants invariants :at-rest (list) :goal settled?))
