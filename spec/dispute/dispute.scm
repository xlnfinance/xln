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
;;   start    any held proof of the CURRENT epoch and a nonce above the chain nonce, or, from epoch 1 on,
;;            the IMPLICIT proof (R-IMPLICIT-BASELINE, Q-D-21, decision D2): empty signature, the empty state of
;;            the Account (offdelta 0, no clause, floor windows, nonce = chain nonce + 1, authored by RIGHT).
;;            Freezes the windows of the proof it starts from; T = S + left + right (each window at least the
;;            floor: H2). No counterparty check.
;;   counter  only the NON-starter, only before T, only with a proof that ranks above the selected
;;            one. Rank = nonce, then Left's proposal over Right's at an equal nonce (R-A1). The counter's
;;            windows are at least the started ones (they may lengthen, never shorten: E9).
;;   finalize 5a a counter is selected: at or after T, anyone.
;;            5c the initial proof stands: at or after T anyone; before T only the non-starter.
;;            5b no counter, the non-starter brings a higher-ranking proof and closes at once.
;;            An HTLC clause whose secret is not public waits for its deadline (H1). The final body's windows
;;            are at least the started ones too (E9).
;;   payout   Δ = ondelta + offdelta (+ the clause, if its secret was public by the deadline).
;;            Δ <= 0: Right takes the collateral and Left owes -Δ. 0 < Δ < c: Δ / c-Δ.
;;            Δ >= c: Left takes c and Right owes Δ-c. A shortfall first enforces the debtor's
;;            older debts, then is paid from what is left of its reserve; the rest becomes debt. The epoch advances: every older proof dies (N1);
;;            each side holds the implicit proof of the new epoch (see start).
;;   deposit  R2C during a dispute is not blocked (H4, accepted): it changes the payout, and only
;;            in favour of the beneficiary of the deposit. A deposit does NOT advance the epoch: every signed
;;            frame of the epoch stays valid, and an implicit dispute started afterwards settles at the NEW
;;            ondelta (review B of PR 76, finding 2). The epoch advances only on a dispute finalize, a
;;            co-signed collateral-to-reserve withdrawal and a settlement.
;;   tie      At nonce stored + 1 a Right-authored SIGNED proof only ties the implicit proof (same rank), and a
;;            tie is a refused counter: Left's frame would be lost (review B, finding 3). Rule for the Runtime
;;            and the specs: the first signed proof of an epoch takes nonce >= stored + 2 (`post-nonce`).
;;   windows  Each proof carries its own windows (the policy it was signed under). They may lengthen and never
;;            shorten inside an epoch (E9 refuses a counter or a final body that shortens them). The floor
;;            windows (60 s testnet, 6 h mainnet) are the real response guarantee: a Runtime duty to watch its
;;            own disputes within the floor.
;;
;; ASSUMPTION the safety properties stand on (stated, not hidden): the non-starter ACTS INSIDE ITS
;; WINDOW. The clock may not reach T while the non-starter holds a proof that outranks the selected
;; one and has not answered. Take it away (bug `no-floor`, windows of zero) and the properties fail.
;;
;;   secrets  a dispute op by the payee carries every secret it knows for the frozen Account's locks,
;;            whichever proof it presents (lesson #37, R3): the calldata IS the reveal. `carry`.
;;   settle   cooperative settlement (Account.sol processSettlement): a bilateral update at a nonce above
;;            the chain nonce. It folds offdelta into ondelta (Δ and the money do not move), sets the chain
;;            nonce to its own nonce and advances the epoch. v1: no open clause. After it the parties sign
;;            one more frame, `post`, Right-authored, whose proof nonce is the chain nonce + 2 (it must
;;            outrank the implicit proof, not tie it), and a dispute may start in the new epoch.
;;
;;   horizon  N2 (coordinator 21:50): a party refuses a lock whose deadline is beyond MAX_LOCK_HORIZON. Under H1
;;            a lock years out blocks cooperative and dispute close until the secret appears. `horizon-ok?`.
;;
;; Not modelled here: Pull clauses (5b/5c wait for T when one is present), swaps, the watchtower
;; (it can only run a counter or an already selected finalize), several tokens (GAP-7), a settlement
;; with open clauses (v2), more than one frame after a settlement. See QUESTIONS.md.
;;
;; Needs lib/vocabulary.scm and lib/check.scm.

;; ---- model bounds
(define/overridable window-left    (s/number) 1)
(define/overridable window-right   (s/number) 1)
(define/overridable min-window     (s/number) 1)
;; N3: each proof carries its own windows: the floor (window-left, window-right) plus `frame-extra`, a policy
;; that may only lengthen them inside an epoch. The base signs every frame at the floor; the config
;; `window-policy` lengthens the later frames (extra 1), so a stale start at the floor is answered by a frame
;; with longer windows.
(define (frame-extra nonce) 0)
;; LAG: the time to read a J event and get an op included (coordinator R-C11, 18:57). Every window
;; must be greater than LAG or a responder that sees the start at S + LAG has no time to counter.
;; The model's tick is the smallest window, so LAG is below one tick here; bug `window-below-lag`
;; sets it to a tick and drops the floor.
(define/overridable lag            (s/number) 0)
(define/overridable max-time       (s/number) 2)
(define/overridable htlc-deadline  (s/number) 1)
;; MAX_LOCK_HORIZON: a named POLICY parameter (default 7 days on the real system, never below the 24 h
;; async window): a lock is refused when its deadline is further away than this from the clock
(define/overridable max-lock-horizon (s/number) 1)
(define/overridable max-disputes   (s/number) 1)
(define/overridable credit-left    (s/number) 1)   ; credit extended TO Left (Q-L-1)
(define/overridable credit-right   (s/number) 1)
(define/overridable collateral0    (s/number) 2)
(define/overridable reserve-left0  (s/number) 1)
(define/overridable reserve-right0 (s/number) 0)
;; what each side already owes THIRD parties from earlier (its older debts, enforced first, Depository._settleShortfall)
(define/overridable older-left0  (s/number) 0)
(define/overridable older-right0 (s/number) 0)
;; one enforcement call clears at most this much older debt (the contract visits at most 32 claims per call; a claim is 1 here)
(define/overridable older-per-call (s/number) 32)
;; the frame heights at which a cooperative settlement is offered (height 2 holds an open clause)
;; H3: the board of one side rotates (0: never; the `retired-left` and `retired-right` configs set 1)
(define/overridable rotations (s/number) 0)
;; the off-chain height at which the board rotates (frames up to it are retired-grade); one height keeps the bound small
(define/overridable rotation-at (s/number) 4)
(define/overridable settle-heights (s/array (s/number)) (list 1 2))

;; ---- the domain
(define sides (list :left :right))
(define (peer side) (if (equal? side :left) :right :left))
;; the FLOOR windows (H2): the implicit proof names them, and no signed proof goes below them
(define (windows) (list window-left window-right))
(define (window-floor-ok?)
  (and (every (lambda (x) (>= x min-window)) (windows))
       (every (lambda (x) (> x lag)) (windows))))
;; a counter sent at `now` lands at now + LAG and must land before T
(define (counter-window-open? w d) (< (+ (:now w) lag) (:timeout d)))

;; A PROOF is what the counterparty signed: (nonce proposer off clause rival? epoch wl wr implicit?). `off` is the
;; offdelta, `clause` is #f or (amount deadline): Left's HTLC payment to Right, paid out if the secret
;; is public by `deadline`. `rival?` marks a losing proposal of a cross-open. `wl` and `wr` are the response
;; windows the proof carries (N3: the policy it was signed under). `implicit?` marks the IMPLICIT proof of
;; an epoch (empty signature, built from chain state; R-IMPLICIT-BASELINE), which no one signed.
;; Proofs are BUILT by the frame rules from the previous committed proof and a tx; nothing here is
;; a table of states. Each side computes the body itself, so "both sides sign the same proof" and
;; "credit holds" are checked on what the rules produced, not on numbers the author chose.
(define (make-proof nonce proposer off clause rival?)
  (list nonce proposer off clause rival? 0
        (+ (car (windows)) (frame-extra nonce)) (+ (cadr (windows)) (frame-extra nonce)) #f))
(define (p-nonce p) (car p))
(define (p-proposer p) (cadr p))
(define (p-off p) (caddr p))
(define (p-clause p) (cadddr p))
(define (p-rival? p) (list-ref p 4))
(define (p-epoch p) (list-ref p 5))
(define (p-wl p) (list-ref p 6))
(define (p-wr p) (list-ref p 7))
(define (p-implicit? p) (list-ref p 8))
(define (p-span p) (+ (p-wl p) (p-wr p)))
(define (with-epoch p e)
  (list (p-nonce p) (p-proposer p) (p-off p) (p-clause p) (p-rival? p) e (p-wl p) (p-wr p) (p-implicit? p)))
;; E9: a body's windows are at least another's (they may lengthen, never shorten)
(define (windows-ge? p q) (and (>= (p-wl p) (p-wl q)) (>= (p-wr p) (p-wr q))))
(define (htlc amount deadline) (list amount deadline))
(define (clause-amount c) (car c))
(define (clause-deadline c) (cadr c))
(define (rank p) (+ (* 2 (p-nonce p)) (if (equal? (p-proposer p) :left) 1 0)))
(define (proof-name p)
  (if (p-implicit? p)
      (str "I" (p-nonce p))
      (str (if (> (p-epoch p) 0) "e" "") "n" (p-nonce p) (if (equal? (p-proposer p) :left) "L" "R") (if (p-rival? p) "'" ""))))

;; the tx of a frame (Δ = ondelta + offdelta, collateral 2, credit 1 each way):
;;   n1 Right pays Left 1 (Δ 1); n2 Left locks a 1-unit HTLC; n3 the lock is cancelled and Right pays
;;   Left 2 (Δ 3: Right owes 1 if the state is final); n4 Left pays Right 4 (Δ -1: Left owes 1);
;;   n5 a payment by Left that would take Left past the credit Right extended (Δ -4): the RCPAN guard
;;   refuses it, bug `no-rcpan` lets it through. The values are the model's; the guard is the rule.
(define script
  (list (list :right (list :pay :right 1))
        (list :left  (list :lock 1))
        (list :right (list :unlock-pay :right 2))
        (list :left  (list :pay :left 4))
        (list :right (list :pay :left 3))))
;; a losing proposal at one nonce: Right proposed at the same height as Left and lost the tie
(define rivals (list (list 2 (list :pay :right 2))))
(define genesis (list 0 :left 0 #f #f 0 0 0 #f))

;; the new proof a tx makes on top of `tip`, or #f if the tx does not apply
(define (apply-op tip op nonce proposer rival?)
  (let ((off (p-off tip)) (clause (p-clause tip)))
    (case (car op)
      ((:pay) (make-proof nonce proposer (ledger-pay off (cadr op) (caddr op)) clause rival?))
      ((:lock) (if clause #f (make-proof nonce proposer off (htlc (cadr op) htlc-deadline) rival?)))
      ((:unlock-pay) (if clause (make-proof nonce proposer (ledger-pay off (cadr op) (caddr op)) #f rival?) #f))
      (else #f))))

;; RCPAN on a proof, in the worst case over its clause: Δ = ondelta + off
;;   -credit-left <= Δ - clause  and  Δ <= collateral + credit-right
(define (rcpan-ok? w p)
  (ledger-rcpan-ok? (+ (:ondelta w) (p-off p)) (if (p-clause p) (clause-amount (p-clause p)) 0) 0
                    (:collateral w) credit-left credit-right))
;; N2: a lock whose deadline is beyond MAX_LOCK_HORIZON is refused by BOTH sides (bug `no-horizon`)
(define (horizon-ok? w p)
  (or (not (p-clause p)) (<= (- (clause-deadline (p-clause p)) (:now w)) max-lock-horizon)))
;; N3: neither side signs a frame whose windows are below those of the newest committed proof (windows never
;; shorten inside an epoch). Bug `counter-shortens-window` signs it, and nothing then refuses the counter.
(define (windows-keep-ok? w p) (windows-ge? p (tip-of w :left)))
(define (frame-ok? w p) (and p (rcpan-ok? w p) (horizon-ok? w p) (windows-keep-ok? w p)))
;; the receiver recomputes the body from ITS committed proof and signs only if it equals the
;; proposer's (bugs `blind-sign` and `no-rcpan` change these)
(define (receiver-body tip op nonce proposer) (apply-op tip op nonce proposer #f))
(define (receiver-accepts? mine theirs) (and mine theirs (equal? mine theirs)))

;; The IMPLICIT proof (R-IMPLICIT-BASELINE, Q-D-21, decision D2): from epoch 1 on, the empty state of the Account is a
;; valid proof for both sides WITHOUT a signature, because every field of it is on chain: offdelta 0, no clause,
;; the FLOOR windows, the nonce one above the chain nonce, authored by RIGHT (watchSeed 0, no starter arguments).
;; No epoch advance leaves a side without a proof, however many disputes follow each other, and no co-signed
;; baseline or nonce arithmetic is needed. At nonce chain + 1 the Right author gives it the LOWEST rank: a
;; Left-authored signed proof of that nonce outranks it, a Right-authored one only TIES it, and a tie is a
;; refused counter. So the first SIGNED proof of an epoch takes nonce chain + 2 (`post-nonce`).
(define (implicit-proof w)
  (list (+ (:chain-nonce w) 1) :right 0 #f #f (:epoch w) (car (windows)) (cadr (windows)) #t))
(define (implicit-proofs w) (if (> (:epoch w) 0) (list (implicit-proof w)) (list)))
(define (rival-at nonce) (find (lambda (r) (= (car r) nonce)) rivals))

(define init
  (dict :epoch 0 :chain-nonce 0 :now 0
        :collateral collateral0 :ondelta 0
        :reserve (dict :left reserve-left0 :right reserve-right0)
        :debt (dict :left 0 :right 0)        ; owed BY the side to its peer
        :older (dict :left older-left0 :right older-right0)   ; owed BY the side to third parties, from before
        :third-paid 0                        ; what enforcement has paid third parties out of the reserves
        :shortfalls (list)                   ; what each shortfall did: reserve and older debt before and after, what the peer got
        :secret #f                           ; #f, or when the secret became public on chain
        :head 0                              ; off-chain height: how many script frames were proposed
        :tip (dict :left genesis :right genesis)   ; the newest proof each side has committed
        :unacked #f                          ; #f, or (proposer's proof, receiver's proof): the proposer waits for the ack
        :proposed-rank 0                     ; rank of the newest frame proposed (the receiver committed it)
        :held (dict :left (list) :right (list))   ; the SIGNED proofs each side holds; the implicit one is derived
        :signed (list)                       ; (proof byz? rcpan-ok?) of every frame a proposer signed
        :knew-op #f                          ; the payee acted before the deadline knowing the secret
        :settlements (list)                  ; what each cooperative settlement did
        :post #f                             ; the frame signed after a settlement
        :deposit #f                          ; (funder beneficiary) of the R2C made in this epoch or dispute (cleared at an advance)
        :deposits 0                          ; how many R2C were made (one is the bound)
        :adv-ondelta 0                       ; ondelta at the last epoch advance (before any deposit of the epoch)
        :rot #f                              ; #f, or the off-chain height when the rotating side's board rotated
        :dispute #f
        :results (list)))

;; ---- off-chain: propose, cross-open, ack
(define (script-left? w) (< (:head w) (length script)))
(define (next-nonce w) (+ (:head w) 1))
(define (tip-of w side) (get-in w (list :tip side)))
(define (hold w side p) (update-in w (list :held side) (lambda (hs) (append hs (list p)))))
(define (frozen? w) (:dispute w))

;; the next scripted frame as (proposer's proof, receiver's proof), or #f when it is not valid
;; the two bodies of the next scripted frame, before any check: (proposer's proof, receiver's proof)
(define (frame-parts w)
  (let* ((entry (list-ref script (:head w)))
         (proposer (car entry)) (op (cadr entry)) (n (next-nonce w))
         (mine (apply-op (tip-of w proposer) op n proposer #f))
         (theirs (receiver-body (tip-of w (peer proposer)) op n proposer)))
    (and mine (list mine theirs))))
;; each side's OWN credit and horizon check on the frame it signs (bugs `proposer-skips-rcpan`,
;; `receiver-skips-rcpan` remove one at a time: the other must stand alone)
(define (proposer-ok? w p) (frame-ok? w p))
(define (receiver-ok? w p) (frame-ok? w p))
;; the next scripted frame as (proposer's proof, receiver's proof), or #f when it is not valid
(define (next-frame w)
  (let ((f (frame-parts w)))
    (and f (proposer-ok? w (car f)) (receiver-accepts? (car f) (cadr f)) (receiver-ok? w (cadr f)) f)))
(define (proposal-enabled? w)
  (and (script-left? w) (not (:unacked w)) (not (frozen? w)) (next-frame w) #t))
(define (proposer-of-next w) (car (list-ref script (:head w))))
;; every frame a proposer signs is recorded, with whether its body passes RCPAN for the proposer
(define (record-signed w p byz?)
  (update-in w (list :signed)
             (lambda (s) (let ((e (list p byz? (if (rcpan-ok? w p) #t #f)))) (if (member e s) s (append s (list e)))))))

;; the proposer sends; the receiver commits its own recomputation and holds the proposer's proof
(define (proposed w f)
  (-> w (assoc-in (list :unacked) f)
        (assoc-in (list :proposed-rank) (rank (car f)))
        (assoc-in (list :tip (peer (p-proposer (car f)))) (cadr f))
        (update-in (list :head) (lambda (h) (+ h 1)))))

;; an honest proposer signs only a frame its own check passes; the receiver then decides on its own
(define propose
  (rule "propose" (w side)
    (when (and (script-left? w) (not (:unacked w)) (not (frozen? w)) (equal? (proposer-of-next w) side)
               (let ((f (frame-parts w))) (and f (proposer-ok? w (car f))))))
    (then (let* ((f (frame-parts w)) (w1 (record-signed w (car f) #f)))
            (if (and (receiver-accepts? (car f) (cadr f)) (receiver-ok? w (cadr f)))
                (proposed (hold w1 (peer side) (car f)) f)
                w1)))))
;; a BYZANTINE proposer signs a frame that overdraws itself: only the receiver's check stands
(define byz-propose
  (rule "byz propose" (w side)
    (when (and (script-left? w) (not (:unacked w)) (not (frozen? w)) (equal? (proposer-of-next w) side)
               (let ((f (frame-parts w))) (and f (not (frame-ok? w (car f)))))))
    (then (let* ((f (frame-parts w)) (w1 (record-signed w (car f) #t)))
            (if (and (receiver-accepts? (car f) (cadr f)) (receiver-ok? w (cadr f)))
                (proposed (hold w1 (peer side) (car f)) f)
                w1)))))

;; a cross-open: Right proposed at the same height. Left's frame wins; Right signed its own, so
;; Left holds Right's losing proposal, Right holds Left's frame.
(define (rival-proof w)
  (let ((r (rival-at (next-nonce w))))
    (and r (apply-op (tip-of w :right) (cadr r) (car r) :right #t))))
(define collide
  (rule "collide" (w side)
    (when (and (equal? side :left) (proposal-enabled? w) (equal? (proposer-of-next w) :left)
               (frame-ok? w (rival-proof w))))
    (then (let ((f (next-frame w)))
            (proposed (-> w (hold :right (car f)) (hold :left (rival-proof w))) f)))))

;; the receiver's signature reaches the proposer, who commits
(define ack
  (rule "ack" (w side)
    (when (and (:unacked w) (equal? (p-proposer (car (:unacked w))) side)))
    (then (-> w (hold side (cadr (:unacked w)))
                (assoc-in (list :tip side) (car (:unacked w)))
                (assoc-in (list :unacked) #f)))))

;; ---- the dispute
(define (selected d) (or (:counter d) (:initial d)))
(define (responder-of d) (peer (:starter d)))
;; what a side may present: the proofs it holds (signed by the counterparty) and the implicit proof of the epoch
(define (signed-held w side) (get-in w (list :held side)))
(define (held-by w side) (append (signed-held w side) (implicit-proofs w)))
(define (all-proofs w) (delete-duplicates (append (held-by w :left) (held-by w :right))))
(define (signed-proofs w) (delete-duplicates (append (signed-held w :left) (signed-held w :right))))
(define (outranks? p q) (> (rank p) (rank q)))
(define (usable? w p) (and (= (p-epoch p) (:epoch w)) (> (p-nonce p) (:chain-nonce w))))
(define (best-rank w side)
  (reduce (lambda (q acc) (max acc (if (usable? w q) (rank q) -1))) -1 (held-by w side)))

;; the honest non-starter answers before the clock reaches T
;; A HASTY close: the non-starter closes before T while the ack of a frame it proposed is still on
;; its way. The contract allows it and it is the responder's own harm (the ack would have brought a
;; better proof), so the record marks it and the "pays what both committed" property skips it; every
;; other property covers it.
(define (own-ack-pending? w side)
  (and (:unacked w) (equal? (p-proposer (car (:unacked w))) side)))
(define (responder-can-answer? w)
  (let ((d (:dispute w)))
    (and d (counter-window-open? w d) (> (best-rank w (responder-of d)) (rank (selected d))))))
(define (blocked-by-response? w)
  (let ((d (:dispute w)))
    (and d (>= (+ (:now w) 1) (:timeout d))
         (or (responder-can-answer? w)
             (and (ack-in-window?) (:unacked w) #t)))))

;; when the clock reaches T the responder's holdings are frozen for the record: a proof that
;; reaches it after the window closed (a late ack) is not one it could have used
(define (close-window w)
  (let ((d (:dispute w)))
    (if (and d (not (:closed-best d)) (>= (:now w) (:timeout d)))
        (assoc-in (assoc-in w (list :dispute :closed-best) (best-rank w (responder-of d)))
                  (list :dispute :closed-proposed) (:proposed-rank w))
        w)))

;; ASSUMPTION (second, stated): a frame's ack reaches its proposer inside the response window: the ack
;; delay is shorter than the window. Without it a dispute can end on a proof one frame behind what
;; both sides had committed (Q-D-3); bug `late-ack` drops the assumption and shows it.
(define (ack-in-window?) #t)

;; ---- the secret in the calldata (#37, R3)
;; The payee (Right) knows the secret once the lock frame exists. Every dispute op it sends carries it,
;; so the chain sees it at the op's time; an op that leaves it out costs the payee the clause when the
;; deadline passes (bug `omits-secret`).
(define (known? w) (>= (:head w) 2))
(define (publish-secret w) (if (:secret w) w (assoc-in w (list :secret) (:now w))))
(define (note-knew w) (if (<= (:now w) htlc-deadline) (assoc-in w (list :knew-op) #t) w))
(define (carry w side)
  (if (and (equal? side :right) (known? w) (= (:epoch w) 0))
      (publish-secret (note-knew w))
      w))

;; ---- time and the public secret
(define tick
  (rule "tick" (w side)
    (when (and (equal? side :left) (< (:now w) max-time) (not (blocked-by-response? w))))
    (then (close-window (update-in w (list :now) (lambda (n) (+ n 1)))))))

(define reveal
  (rule "reveal" (w side)
    (when (and (equal? side :right) (not (:secret w)) (>= (:head w) 2) (= (:epoch w) 0)))
    (then (assoc-in w (list :secret) (:now w)))))

(define (start-with p)
  (rule (str "start " (proof-name p)) (w side)
    (when (and (not (:dispute w)) (< (length (:results w)) max-disputes)
               (member p (held-by w side)) (usable? w p) (window-floor-ok?)
               (<= (+ (:now w) (p-span p)) max-time)))
    (then (close-window
           (assoc-in (carry w side) (list :dispute)
                     (dict :starter side :at (:now w) :timeout (+ (:now w) (p-span p))
                           :initial p :counter #f :closed-best #f :closed-proposed #f :counter-at #f
                           :best-start? (= (rank p) (best-rank w side))))))))

;; E9: a counter or a final body may lengthen the started windows, never shorten them (bug `counter-shortens-window`)
(define (windows-ok? d p) (windows-ge? p (:initial d)))
(define (counter-with p)
  (rule (str "counter " (proof-name p)) (w side)
    (when (and (:dispute w) (equal? side (responder-of (:dispute w)))
               (member p (held-by w side)) (usable? w p)
               (counter-window-open? w (:dispute w))
               (windows-ok? (:dispute w) p)
               (outranks? p (selected (:dispute w)))))
    (then (assoc-in (assoc-in (carry w side) (list :dispute :counter) p) (list :dispute :counter-at) (:now w)))))

;; ---- what the payout is worth
(define (secret-public-by? w deadline) (and (:secret w) (<= (:secret w) deadline)))
;; :none, :paid, :unpaid, or :wait (H1: unrevealed and the deadline has not passed)
(define (clause-outcome w p)
  (let ((c (p-clause p)))
    (cond ((not c) :none)
          ((secret-public-by? w (clause-deadline c)) :paid)
          ((<= (:now w) (clause-deadline c)) :wait)
          (else :unpaid))))
(define (final-delta w p outcome)
  (- (+ (:ondelta w) (p-off p)) (if (equal? outcome :paid) (clause-amount (p-clause p)) 0)))

;; ---- H3: evidence signed by a RETIRED board is valid but limited. A proof the rotating side signed before its
;; board rotated is graded retired (verified under a previous board); the contract clamps only the direction in
;; which that side would pay from reserves: retired Left settles at Δ >= 0, retired Right at Δ <= collateral.
;; What the retired side is OWED is never clamped, or a debtor could erase its debt by racing the rotation.
;; The grade belongs to the proof that settles (a counter replaces it), not to who starts.
(define (rotating-side) :left)
(define (signed-at w p)
  (cond ((p-implicit? p) #f)
        ((equal? p (:post w)) #f)
        ((= (p-epoch p) 0) (p-nonce p))
        (else #f)))
(define (retired-of w p)
  (let ((k (signed-at w p)))
    (if (and (:rot w) k (<= k (:rot w))) (rotating-side) :none)))
(define (clamp-retired retired delta collateral)
  (cond ((equal? retired :left) (max delta 0))
        ((equal? retired :right) (min delta collateral))
        (else delta)))
(define (settled-delta w p outcome)
  (clamp-retired (retired-of w p) (final-delta w p outcome) (:collateral w)))
(define rotate
  (rule "rotate board" (w side)
    (when (and (> rotations 0) (not (:rot w)) (equal? side (rotating-side)) (not (:dispute w)) (null? (:results w))
               (= (:epoch w) 0) (= (:head w) rotation-at)))
    (then (assoc-in w (list :rot) (:head w)))))

(define (add-reserve w side amount) (update-in w (list :reserve side) (lambda (r) (+ r amount))))
;; a shortfall: the chain enforces the debtor's older debts first, from its reserve (`enforce-older`; bug
;; `shortfall-skips-enforcement`), pays the peer out of the SPENDABLE reserve, the reserve less what is still owed (`payable`;
;; bug `shortfall-ahead-of-debt`: the raw reserve), and books the rest as debt (Depository._settleShortfall)
(define (older-of w side) (get-in w (list :older side)))
(define (enforce-older w side)
  (let ((pay (min (older-of w side) (get-in w (list :reserve side)) older-per-call)))
    (-> w (add-reserve side (- pay)) (update-in (list :older side) (lambda (o) (- o pay)))
          (update-in (list :third-paid) (lambda (t) (+ t pay))))))
(define (payable w side) (max 0 (- (get-in w (list :reserve side)) (older-of w side))))
(define (shortfall w debtor amount)
  (let* ((w0 (enforce-older w debtor))
         (pay (min amount (payable w0 debtor)))
         (w1 (-> w0 (add-reserve debtor (- pay)) (add-reserve (peer debtor) pay)
                    (update-in (list :debt debtor) (lambda (d) (+ d (- amount pay)))))))
    (update-in w1 (list :shortfalls)
               (lambda (l) (append l (list (dict :amount amount :reserve (get-in w (list :reserve debtor)) :older (older-of w debtor)
                                                 :got (- (get-in w1 (list :reserve (peer debtor))) (get-in w (list :reserve (peer debtor))))
                                                 :reserve-after (get-in w1 (list :reserve debtor)) :older-after (older-of w1 debtor)
                                                 :enforced (- (:third-paid w1) (:third-paid w)))))))))
(define (payout w delta)
  (let ((c (:collateral w))
        (w0 (-> w (assoc-in (list :collateral) 0) (assoc-in (list :ondelta) 0))))
    (cond ((<= delta 0) (shortfall (add-reserve w0 :right c) :left (- delta)))
          ((< delta c)  (add-reserve (add-reserve w0 :left delta) :right (- c delta)))
          (else         (shortfall (add-reserve w0 :left c) :right (- delta c))))))

(define (adopted? d p) (not (equal? p (:initial d))))

;; what a side owns outside the collateral: reserve, less what it owes, plus what it is owed
(define (net w side)
  (- (+ (get-in w (list :reserve side)) (get-in w (list :debt (peer side)))) (get-in w (list :debt side)) (older-of w side)))

;; the record the properties read: what was decided, on what, and what each side owned before and after
(define (record w paid d p outcome path)
  (let* ((cf (undo-deposit w))
         (cf-paid (payout cf (settled-delta cf p outcome))))
   (dict :proof p :path path :starter (:starter d) :delta (settled-delta w p outcome)
        :raw-delta (final-delta w p outcome) :retired (retired-of w p)
        :outcome outcome :at (:now w) :epoch (:epoch w) :proof-epoch (p-epoch p) :collateral (:collateral w)
        :best-start? (:best-start? d)
        :net-before-left (net w :left) :net-before-right (net w :right)
        :net-after-left (net paid :left) :net-after-right (net paid :right)
        :cf-net-left (net cf-paid :left) :cf-net-right (net cf-paid :right)
        :funded-left (funded w :left) :funded-right (funded w :right)
        :best-held (or (:closed-best d) (best-rank w (responder-of d)))
        :believed (or (:closed-proposed d) (:proposed-rank w))
        :acked (min (rank (tip-of w :left)) (rank (tip-of w :right)))
        :ondelta (:ondelta w) :secret (:secret w) :initial (:initial d) :counter-at (:counter-at d)
        :timeout (:timeout d) :adopted (adopted? d p)
        :knew-op (:knew-op w) :post (:post w)
        :adv-ondelta (:adv-ondelta w) :dep-left (if (and (:deposit w) (equal? (cadr (:deposit w)) :left)) 1 0)
        :hasty (and (< (:now w) (:timeout d)) (own-ack-pending? w (responder-of d))))))

(define (finalized w d p outcome path)
  (let ((paid (payout w (settled-delta w p outcome))))
    (-> paid
        (assoc-in (list :dispute) #f)
        (assoc-in (list :deposit) #f)
        (assoc-in (list :adv-ondelta) (:ondelta paid))
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
            (finalized (carry w side) d (:counter d) (clause-outcome (carry w side) (:counter d)) "5a")))))

;; 5c: the initial proof stands. After T anyone; before T only the non-starter, and an honest
;; one does not close on something worse than the best proof it holds.
(define finalize-initial
  (rule "finalize initial" (w side)
    (when (and (:dispute w) (not (:counter (:dispute w)))
               (or (>= (:now w) (:timeout (:dispute w)))
                   (and (equal? side (responder-of (:dispute w))) (not (responder-can-answer? w))))
               (not (equal? (clause-outcome w (:initial (:dispute w))) :wait))))
    (then (let ((d (:dispute w)))
            (finalized (carry w side) d (:initial d) (clause-outcome (carry w side) (:initial d)) "5c")))))

;; 5b: no counter is registered; the non-starter brings its best proof, which outranks the
;; initial one, and closes at once
(define (finalize-with p)
  (rule (str "finalize with " (proof-name p)) (w side)
    (when (and (:dispute w) (not (:counter (:dispute w))) (equal? side (responder-of (:dispute w)))
               (member p (held-by w side)) (usable? w p) (outranks? p (:initial (:dispute w)))
               (windows-ok? (:dispute w) p)
               (= (rank p) (best-rank w side))
               (not (equal? (clause-outcome w p) :wait))))
    (then (let ((d (:dispute w)))
            (finalized (carry w side) d p (clause-outcome (carry w side) p) "5b")))))

;; ---- cooperative settlement (Account.sol processSettlement) and the frame after it
;; The settlement is the next frame: its nonce is above the chain nonce.
(define (settle-nonce w) (+ (:head w) 1))
;; v1: a settlement carries no open clause (bug `settle-with-clause`)
(define (settle-clause-ok? w) (not (p-clause (tip-of w :left))))
;; the offdelta folds into ondelta, so Δ does not move (bug `settle-drops-off`)
(define (folded-off off) off)
(define (hold-both w p) (hold (hold w :left p) :right p))

(define (settle-enabled? w)
  (and (= (:epoch w) 0) (null? (:results w)) (not (frozen? w)) (not (:unacked w))
       (member (:head w) (vector->list settle-heights)) (> (:head w) 0) (settle-clause-ok? w)))
(define settle
  (rule "settle" (w side)
    (when (and (equal? side :left) (settle-enabled? w)))
    (then (let* ((tip (tip-of w :left))
                 (delta-before (+ (:ondelta w) (p-off tip)))
                 (w1 (-> w (assoc-in (list :epoch) 1)
                           (assoc-in (list :chain-nonce) (settle-nonce w))
                           (update-in (list :ondelta) (lambda (o) (+ o (folded-off (p-off tip)))))
                           (assoc-in (list :head) (length script))))
                 (w2 (assoc-in w1 (list :adv-ondelta) (:ondelta w1))))
            (update-in w2 (list :settlements)
                       (lambda (ss) (cons (dict :delta-before delta-before :delta-after (:ondelta w2)
                                                :money-before (total-funds w) :money-after (total-funds w2)
                                                :had-clause (if (p-clause tip) #t #f))
                                          ss)))))))

;; the first SIGNED frame of the new epoch: Right pays Left 1. Right-authored, so at chain nonce + 1 it would only TIE
;; the implicit proof (same rank) and a counter with it is refused: the dispute would pay the implicit proof and
;; Left's frame would be lost (review B of PR 76, finding 3). The rule: the first signed proof of an epoch takes
;; nonce >= stored + 2. Bug `post-nonce-low` takes chain + 1.
(define (post-nonce w) (+ 2 (:chain-nonce w)))
(define (post-proof w)
  (with-epoch (apply-op (implicit-proof w) (list :pay :right 1) (post-nonce w) :right #f) (:epoch w)))
(define post-frame
  (rule "post frame" (w side)
    (when (and (equal? side :right) (= (:epoch w) 1) (null? (:results w)) (not (frozen? w)) (not (:post w))
               (pair? (:settlements w)) (rcpan-ok? w (post-proof w))))
    (then (let ((p (post-proof w)))
            (-> w (assoc-in (list :post) p)
                  (assoc-in (list :proposed-rank) (rank p))
                  (assoc-in (list :tip :left) p) (assoc-in (list :tip :right) p)
                  (hold-both p))))))

;; H4 (coordinator): R2C has no dispute check (Account.sol processR2C), so a deposit made while a
;; dispute is open changes the payout. Accepted: each deposit only raises its beneficiary's share.
;; The receiving entity need not be the funder. One deposit of 1, during a dispute, or (review B of PR 76,
;; finding 2) inside an epoch after an advance and before a later dispute can start: a deposit does NOT advance the
;; epoch, so the signed frames of the epoch stay valid and an implicit dispute started afterwards settles at the
;; NEW ondelta (a Left deposit raises it by one). Bug `deposit-advances-epoch`.
(define (deposit-open? w)
  (or (:dispute w) (and (> (:epoch w) 0) (< (length (:results w)) max-disputes))))
(define (deposit-rule funder beneficiary)
  (rule (str "deposit " funder "->" beneficiary) (w side)
    (when (and (equal? side funder) (deposit-open? w) (= (:deposits w) 0) (>= (get-in w (list :reserve funder)) 1)))
    (then (-> w (update-in (list :collateral) (lambda (c) (+ c 1)))
                (update-in (list :ondelta) (lambda (o) (ledger-deposit-ondelta o beneficiary 1)))
                (add-reserve funder -1)
                (update-in (list :deposits) (lambda (n) (+ n 1)))
                (assoc-in (list :deposit) (list funder beneficiary))))))
(define (undo-deposit w)
  (if (:deposit w)
      (let ((funder (car (:deposit w))) (beneficiary (cadr (:deposit w))))
        (-> w (update-in (list :collateral) (lambda (c) (- c 1)))
              (update-in (list :ondelta) (lambda (o) (ledger-deposit-ondelta o beneficiary -1)))
              (add-reserve funder 1)
              (assoc-in (list :deposit) #f)))
      w))
(define (funded w side) (if (and (:deposit w) (equal? (car (:deposit w)) side)) 1 0))

(define (rules-for w)
  (let ((ps (all-proofs w)))
    (append (list propose byz-propose collide ack tick reveal rotate settle post-frame finalize-counter finalize-initial
                  (deposit-rule :left :left) (deposit-rule :right :right)
                  (deposit-rule :left :right) (deposit-rule :right :left))
            (map start-with ps) (map counter-with ps) (map finalize-with ps))))
(define (next w) (successors (rules-for w) sides w))

;; ---- properties
(define (total-funds w)
  (+ (get-in w (list :reserve :left)) (get-in w (list :reserve :right)) (:collateral w) (:third-paid w)))

(define invariants
  (list
   ;; the four properties Arthur named
   (property "a dispute pays out what the selected state says: net left + Δ, net right + collateral - Δ" (w)
     (every (lambda (r)
              (and (= (:net-after-left r)  (+ (:net-before-left r)  (:delta r)))
                   (= (:net-after-right r) (+ (:net-before-right r) (- (:collateral r) (:delta r))))))
            (:results w)))
   ;; restated from the shortfall records, not through `payable` or `enforce-older` (a planted bug redefines those)
   (property "a shortfall pays the peer no more than the debtor's spendable reserve: its reserve less its older debts (R2C-DEBT-FIRST)" (w)
     (every (lambda (s) (<= (:got s) (max 0 (- (:reserve s) (:older s))))) (:shortfalls w)))
   (property "a shortfall enforces the debtor's older debts first: afterwards they are paid, its reserve is empty, or the call's cap was reached (R2C-DEBT-FIRST)" (w)
     (every (lambda (s) (or (= (:older-after s) 0) (= (:reserve-after s) 0) (>= (:enforced s) older-per-call))) (:shortfalls w)))
   (property "a shortfall pays the peer all of the debtor's spendable reserve it can: the smaller of the amount and the reserve less its older debts (R2C-DEBT-FIRST)" (w)
     (every (lambda (s) (= (:got s) (min (:amount s) (max 0 (- (:reserve s) (:older s)))))) (:shortfalls w)))
   (property "one enforcement call pays at most the call's cap of older debt (R2C-DEBT-FIRST)" (w)
     (every (lambda (s) (<= (:enforced s) older-per-call)) (:shortfalls w)))
   (property "money is conserved: reserves + collateral never change" (w)
     (= (total-funds w) (+ collateral0 reserve-left0 reserve-right0)))
   (property "credit holds: what a side owes never exceeds the credit extended to it" (w)
     (and (<= (get-in w (list :debt :left)) credit-left)
          (<= (get-in w (list :debt :right)) credit-right)))
   (property "both sides sign the same proof: proofs of one nonce, proposer and kind have one body" (w)
     (let ((ps (signed-proofs w)))
       (every (lambda (p)
                (every (lambda (q)
                         (or (not (and (= (p-nonce p) (p-nonce q)) (equal? (p-proposer p) (p-proposer q))
                                       (equal? (p-rival? p) (p-rival? q)) (= (p-epoch p) (p-epoch q))))
                             (equal? p q)))
                       ps))
              ps)))
   (property "an honest proposer never signs a frame that overdraws itself (its own RCPAN check)" (w)
     (every (lambda (e) (or (cadr e) (caddr e))) (:signed w)))
   ;; the credit bound written out again from the formula (money/core.scm), not through the shared function
   (property "a frame that overdraws its proposer is never held: the receiver's own RCPAN check stands alone" (w)
     (every (lambda (p)
              (or (not (= (p-epoch p) (:epoch w)))
                  (let ((delta (+ (:ondelta w) (p-off p))) (locked (if (p-clause p) (clause-amount (p-clause p)) 0)))
                    (and (>= (- delta locked) (- credit-left)) (<= delta (+ (:collateral w) credit-right))))))
            (all-proofs w)))
   (property "no frame is in flight: both sides have committed the same proof" (w)
     (or (:unacked w) (:dispute w) (pair? (:results w)) (equal? (tip-of w :left) (tip-of w :right))))
   ;; what the parties may rely on
   ;; B2 (reviewer): the hasty carve-out below has a floor of its own. A responder that closes before T while
   ;; the ack of its own frame is still on the way may lose that frame, but never a frame both sides acked.
   (property "a hasty close still pays at least the newest frame both sides acked" (w)
     (every (lambda (r) (or (not (:hasty r)) (>= (rank (:proof r)) (:acked r)))) (:results w)))
   (property "the responder is never worse off than the newest proof it held" (w)
     (every (lambda (r) (>= (rank (:proof r)) (:best-held r))) (:results w)))
   (property "a dispute pays what both sides had committed: the final proof ranks at least the newest frame proposed by T" (w)
     (every (lambda (r) (or (:hasty r) (>= (rank (:proof r)) (:believed r)))) (:results w)))
   ;; a starter that starts with a stale proof is the one that pays for it; an honest starter is not
   (property "an honest starter never ends on a losing proposal" (w)
     (every (lambda (r) (or (not (:best-start? r)) (not (p-rival? (:proof r))))) (:results w)))
   ;; H4: a deposit made during a dispute costs no side more than the side funded
   (property "a deposit during a dispute raises only its beneficiary's share: no side loses more than it funded" (w)
     (every (lambda (r)
              (and (>= (+ (:net-after-left r) (:funded-left r)) (:cf-net-left r))
                   (>= (+ (:net-after-right r) (:funded-right r)) (:cf-net-right r))))
            (:results w)))
   (property "only a proof of the current epoch pays out" (w)
     (every (lambda (r) (= (:proof-epoch r) (:epoch r))) (:results w)))
   ;; revised N1: no gap between the epoch advancing and a valid proof
   (property "after an epoch advance each side still holds a valid proof of the new epoch" (w)
     (or (= (:epoch w) 0)
         (every (lambda (side) (some (lambda (p) (usable? w p)) (held-by w side))) sides)))
   ;; the settlement branch and nonce continuity (N1)
   (property "a cooperative settlement moves nothing: Δ and the money are the same before and after" (w)
     (every (lambda (s) (and (= (:delta-before s) (:delta-after s)) (= (:money-before s) (:money-after s)))) (:settlements w)))
   (property "a cooperative settlement carries no open clause (v1)" (w)
     (every (lambda (s) (not (:had-clause s))) (:settlements w)))
   ;; review B of PR 76, finding 3: a Right-authored signed frame at stored + 1 only TIES the implicit proof, a tie is a
   ;; refused counter, and the dispute pays the implicit proof: the frame's offdelta is lost (bug `post-nonce-low`)
   (property "in the new epoch a dispute pays the newest committed frame, never the implicit proof that ties it" (w)
     (every (lambda (r) (or (not (:post r)) (not (= (:epoch r) (p-epoch (:post r)))) (equal? (:proof r) (:post r)))) (:results w)))
   ;; R-IMPLICIT-BASELINE: the implicit proof is the empty state, so a dispute from it settles at the chain's ondelta now:
   ;; the one of the advance, plus a Left deposit made inside the epoch (a deposit does not advance the epoch)
   (property "a dispute from the implicit proof settles at the chain's ondelta now: the advance's plus a deposit of the epoch" (w)
     (every (lambda (r)
              (or (not (p-implicit? (:proof r)))
                  (= (:raw-delta r) (+ (:adv-ondelta r) (:dep-left r)))))
            (:results w)))
   ;; N3 (review B, risk 5; E9): windows may lengthen and never shorten inside an epoch, on the proofs of the epoch and
   ;; on the counter or the final body of a dispute against the windows it started with
   (property "windows never shorten inside an epoch: a later proof carries at least the windows of an earlier one, and a counter or final body at least the started ones" (w)
     (and (every (lambda (p)
                   (every (lambda (q)
                            (or (not (and (= (p-epoch p) (p-epoch q)) (< (p-nonce p) (p-nonce q)))) (windows-ge? q p)))
                          (all-proofs w)))
                 (all-proofs w))
          (every (lambda (r) (windows-ge? (:proof r) (:initial r))) (:results w))))
   (property "no lock is signed beyond MAX_LOCK_HORIZON: every held clause is within the horizon of the clock (N2)" (w)
     (every (lambda (p) (or (not (p-clause p)) (<= (clause-deadline (p-clause p)) (+ (:now w) max-lock-horizon))))
            (all-proofs w)))
   (property "an HTLC is never settled as unpaid before its deadline" (w)
     (every (lambda (r) (or (not (equal? (:outcome r) :unpaid)) (> (:at r) (clause-deadline (p-clause (:proof r))))))
            (:results w)))
   ;; the payout, restated from the contract's rule and not through the page's own helpers
   (property "no reserve, collateral or debt is ever negative" (w)
     (and (>= (get-in w (list :reserve :left)) 0) (>= (get-in w (list :reserve :right)) 0)
          (>= (:collateral w) 0) (>= (get-in w (list :debt :left)) 0) (>= (get-in w (list :debt :right)) 0)))
   (property "Δ = ondelta + offdelta, less the clause if it paid" (w)
     (every (lambda (r)
              (= (:raw-delta r) (- (+ (:ondelta r) (p-off (:proof r)))
                               (if (equal? (:outcome r) :paid) (clause-amount (p-clause (:proof r))) 0))))
            (:results w)))
   (property "a clause pays exactly when its secret was public by the deadline" (w)
     (every (lambda (r)
              (let ((c (p-clause (:proof r))))
                (or (not c)
                    (equal? (equal? (:outcome r) :paid)
                            (and (:secret r) (<= (:secret r) (clause-deadline c)))))))
            (:results w)))
   ;; #37 / R3: the payee that acts before the deadline knowing the secret is paid
   (property "a payee that acted before the deadline knowing the secret is never left with the clause unpaid (#37)" (w)
     (every (lambda (r) (or (not (:knew-op r)) (not (equal? (:outcome r) :unpaid)))) (:results w)))
   ;; H3, from the decision text and not through the clamp function
   (property "retired-board evidence never draws on the retired side's reserve: retired Left settles at Δ >= 0, retired Right at Δ <= collateral (H3)" (w)
     (every (lambda (r) (and (or (not (equal? (:retired r) :left)) (>= (:delta r) 0))
                             (or (not (equal? (:retired r) :right)) (<= (:delta r) (:collateral r)))))
            (:results w)))
   (property "what the retired side is owed is paid as signed, whoever starts (H3)" (w)
     (every (lambda (r) (and (or (not (equal? (:retired r) :left)) (< (:raw-delta r) 0) (= (:delta r) (:raw-delta r)))
                             (or (not (equal? (:retired r) :right)) (> (:raw-delta r) (:collateral r)) (= (:delta r) (:raw-delta r)))))
            (:results w)))
   ;; A12 (coordinator, 00:49): two co-signed proofs exist at one nonce only with opposite proposer flags, and LEFT's proposal
   ;; wins whoever starts or counters. Restated from the rule: proposers, then who ranks higher.
   (property "two proofs of one nonce and epoch have opposite proposers, and Left's outranks Right's (A12)" (w)
     (let ((ps (signed-proofs w)))
       (every (lambda (p)
                (every (lambda (q)
                         (or (not (and (= (p-nonce p) (p-nonce q)) (= (p-epoch p) (p-epoch q)) (not (equal? p q))))
                             (and (not (equal? (p-proposer p) (p-proposer q)))
                                  (or (not (equal? (p-proposer p) :left)) (outranks? p q)))))
                       ps))
              ps)))
   (property "a counter is registered strictly before T" (w)
     (every (lambda (r) (or (not (:counter-at r)) (< (:counter-at r) (:timeout r)))) (:results w)))
   (property "a timeout finalize consumes exactly one nonce; an adopted proof sets it" (w)
     (or (null? (:results w))
         (let ((r (car (:results w))))
           (= (:chain-nonce w) (if (:adopted r) (p-nonce (:proof r)) (+ (p-nonce (:initial r)) 1))))))))

;; finished: a dispute was settled, or the model's clock has run out with none active (no window fits)
(define (settled? w)
  (or (pair? (:results w))
      (and (not (:dispute w)) (> (+ (:now w) (apply + (windows))) max-time))))
;; ---- step properties: the ledger's steps (money/ledger.scm), checked on the dispute page's own steps.
;; The frames here are built from the ledger arithmetic (money/core.scm); these say what each frame and
;; deposit DID, from the ledger page's formulas written out again, so the two pages cannot drift apart.
(define (frame-rule? rname) (or (equal? rname "propose") (equal? rname "byz propose")))
(define (payer-sign side) (if (equal? side :left) -1 1))
(define steps
  (list
   (step-property "a frame moves Δ as the ledger does: a payment moves the payer's allocation, a lock or a lapse leaves Δ" (w rname side w2)
     (or (not (frame-rule? rname)) (not (:unacked w2))
         (let* ((op (cadr (list-ref script (:head w))))
                (p (car (:unacked w2))) (old (tip-of w side)))
           (case (car op)
             ((:pay) (and (= (p-off p) (+ (p-off old) (* (payer-sign (cadr op)) (caddr op)))) (equal? (p-clause p) (p-clause old))))
             ((:lock) (and (= (p-off p) (p-off old)) (p-clause p) (= (clause-amount (p-clause p)) (cadr op))))
             ((:unlock-pay) (and (= (p-off p) (+ (p-off old) (* (payer-sign (cadr op)) (caddr op)))) (not (p-clause p))))
             (else #f)))))
   ;; review B, finding 2: reserve-to-collateral does NOT advance the epoch, so every signed frame stays valid
   (step-property "a deposit does not advance the epoch: the epoch, the chain nonce and every held proof stay" (w rname side w2)
     (or (not (string-prefix? "deposit" rname))
         (and (= (:epoch w2) (:epoch w)) (= (:chain-nonce w2) (:chain-nonce w)) (equal? (:held w2) (:held w)))))
   (step-property "a deposit moves one unit from the funder's reserve into the collateral; only a Left beneficiary's allocation rises" (w rname side w2)
     (or (not (string-prefix? "deposit" rname))
         (let ((beneficiary (cadr (:deposit w2))))
           (and (= (:collateral w2) (+ (:collateral w) 1))
                (= (get-in w2 (list :reserve side)) (- (get-in w (list :reserve side)) 1))
                (= (get-in w2 (list :reserve (peer side))) (get-in w (list :reserve (peer side))))
                (= (:ondelta w2) (+ (:ondelta w) (if (equal? beneficiary :left) 1 0)))))))))

(define dispute (dict :init init :next next :invariants invariants :steps steps :at-rest (list) :goal settled?))
