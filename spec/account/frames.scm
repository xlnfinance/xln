;; Bilateral Account frames: a description, not an implementation.
;;
;; Two replicas, :left and :right, and one link into each. A replica holds its committed
;; history (newest frame first), a mempool, at most one pending frame, the txs it refused,
;; its ATTEMPT number (the refusals it has handled on this head) and its refusal MARK (the
;; highest attempt it refused as a receiver on this head). A frame is (txs, prev, attempt,
;; author); the frame hash is abstracted as the history of those entries, so equal heads
;; mean equal hashes and the attempt and the author are part of the name.
;;
;; The round: a replica proposes a frame of its mempool on top of its head; the peer
;; commits it and answers with an ack; the proposer commits on the ack. A peer that cannot
;; apply the frame answers with a REFUSAL instead.
;;
;; The rules that decide everything (sources in spec/QUESTIONS.md):
;;   - Same-height collision: LEFT WINS (Types.sol:150, Account.sol:732; lessons R-A1).
;;     Left ignores right's frame and keeps its own; right rolls its frame back (its txs go
;;     back ahead of its mempool), commits left's, and acks.
;;   - A frame that is not the next one is IGNORED, never fatal (lessons R-X1): a stale or
;;     future frame changes nothing. A duplicate of the frame at my head is answered with
;;     the same ack again, so a lost ack cannot wedge the proposer.
;;   - Re-validation: a tx is checked against the committed history when it is proposed.
;;     One that no longer holds (its `conflicts` predecessor was committed while it waited)
;;     is REFUSED with notice, into :refused; it is never silently lost.
;;   - R-FRAME-REFUSAL: a receiver that cannot apply a frame (a tx that conflicts with the
;;     history, a lock whose deadline has passed in flight, an expire the receiver's view
;;     says is not due yet) answers with a refusal naming the frame hash, the index of the
;;     first tx it refused and a FAULT tag. The proposer commits only on an ack, so on a
;;     refusal of its pending frame it rolls the frame back and re-proposes. A retryable
;;     fault (it passes with the peer's view moving: `not_expired`, `deadline_too_far`) puts
;;     EVERY tx of the frame back with no notice, up to the retry budget `max-attempt`; any
;;     other fault, or a spent budget, drops the named tx WITH NOTICE (R-NOTICE, it also
;;     releases the payer) and puts the rest back. A refusal for a frame that is no longer
;;     pending (it committed, or was rolled back already) is ignored. Left wins still
;;     decides simultaneous proposals. Until this rule a refused pending frame was stuck for
;;     good, and a stuck Left frame blocked Right too: the page had no clock to show it.
;;   - ATTEMPT NUMBER (A4a): a frame carries `attempt`, the refusals its proposer has
;;     handled on this head (part of the frame's content, so of its hash). The receiver
;;     keeps ONE mark per head: the highest attempt it refused, with the fault. A frame at
;;     or below the mark is not judged: equal attempt, the same refusal again; below, a
;;     refusal with the fault `stale_attempt` that carries the mark. A frame above the
;;     mark is judged afresh. The mark is forgotten when the head moves. The proposer sets
;;     its next attempt to max(own, mark) + 1. Why: an honest proposer never sends two
;;     different frames at one attempt, so a forged frame refused at attempt 0 also
;;     refuses a genuine frame at attempt 0 on that head; and a receiver that forgot its
;;     refusal could commit a frame whose proposer already took it back (a fork).
;;   - FRAME AUTHOR: a frame names its author, in its hash. A replica refuses (silently) a
;;     frame whose author is itself, so it can never commit its own frame as the peer's.
;;   - The link may lose and duplicate messages (bounded budgets); a proposer with a
;;     pending frame may always resend it (a timeout, abstracted as "at any time").
;;
;; The clock: a COARSE J CLOCK (the chain height, 0..max-clock) that a rule ticks, so it can
;; move between a frame's proposal and its receipt. Each side reads it when it proposes and
;; when it receives, and the read may lag the clock by up to `view-lag` (a view that is
;; not remembered between reads: an adversarial lag, each read free). Two clock-dependent
;; tx kinds: a LOCK is applicable while the judging view is below its deadline (and the
;; deadline is within `lock-horizon` of the view), an EXPIRE only when the view is past the
;; deadline. The proposer judges its mempool by its own view; a tx whose fault is retryable
;; waits in the mempool (and holds back the txs behind it, which keeps submission order).
;;
;; Bounds that stand for the real ones: the attempt budget `max-attempt` is 2 (MAX_ATTEMPTS
;; is 8 in the kernel); the J clock runs 0..2 with a lock deadline of 1 (a real chain runs
;; for ever, the deadline is a J height); the view lag is 1 (LAG). The default world is Left's
;; lock and expire against Right's x, one lost message; the configs in account/configs widen it
;; one way at a time (lossy: the first page's conflicts, losses and repeats; repeats; reflect;
;; far-lock; same-side-conflict; reorder).
;;
;; Abstractions (what this page does NOT cover):
;;   - a receiver commits a frame when it arrives; xln.ts holds it as a `received`
;;     candidate first;
;;   - a frame and its ack are separate messages (xln.ts can ride an ack on the next frame);
;;   - the link is FIFO: messages are lost or duplicated, never reordered (config reorder);
;;   - frame content is a list of txs whose meaning is the `conflicts` relation and the
;;     clock; there is no ledger yet, so a bad hanko and a bad state root are not modelled;
;;   - a Byzantine proposer (a frame that is invalid on content) is refused by the same
;;     path as a stale one; it is not a separate rule. Its forged frame is at attempt 0;
;;   - a refusal index that names no tx of the pending frame is ignored (kernel F3);
;;   - the kernel's attempt cap on the receiver side is not modelled: attempts keep counting.
;;
;; Needs lib/vocabulary.scm (rule, property) and lib/check.scm (successors).

;; ---- model bounds: declared, typed inputs of this page
(define/overridable left-txs   (s/array (s/string)) (list "lock" "expire"))
(define/overridable right-txs  (s/array (s/string)) (list "x"))
;; (earlier later): `later` is invalid once `earlier` is committed
(define/overridable conflicts  (s/array (s/array (s/string))) (list (list "lock" "x")))
(define/overridable max-losses (s/number) 1)
;; repeated messages and reflected frames are bounded by configs (repeats, reflect): together with the clock
;; they multiply the state space by an order of magnitude
(define/overridable max-dups   (s/number) 0)
;; frames a Byzantine proposer forges: its whole mempool as one frame, whatever it holds
(define/overridable max-byz    (s/number) 1)
;; times a replica is handed its own pending frame back as if the peer had sent it
(define/overridable max-reflect (s/number) 0)
;; the J clock: it ticks 0..max-clock; a side's read lags it by 0..view-lag
(define/overridable max-clock  (s/number) 2)
(define/overridable view-lag   (s/number) 1)
;; clock-dependent txs: a lock is applicable while view < lock-deadline <= view + lock-horizon;
;; an expire only when lock-deadline < view
(define/overridable lock-txs     (s/array (s/string)) (list "lock"))
(define/overridable expire-txs   (s/array (s/string)) (list "expire"))
(define/overridable lock-deadline (s/number) 1)
(define/overridable lock-horizon  (s/number) 1)
;; the retry budget per head (MAX_ATTEMPTS is 8 in the kernel)
(define/overridable max-attempt (s/number) 2)

;; ---- the world
(define sides (list :left :right))
(define (peer side) (if (equal? side :left) :right :left))
(define (txs-of side) (vector->list (if (equal? side :left) left-txs right-txs)))
(define (conflict-pairs) (map vector->list (vector->list conflicts)))
(define (replica) (dict :head (list) :mempool (list) :pending #f :refused (list) :attempt 0 :mark #f))
(define init
  (dict :left   (replica)
        :right  (replica)
        :inbox  (dict :left (list) :right (list))
        :count  (dict :left 0 :right 0)     ; txs submitted so far, per side
        :clock  0
        :lost   0
        :dups   0
        :byz    0
        :reflect 0))

;; ---- frames and messages
;; the hash of a frame is the history it makes: its entry (txs, attempt, author) on top of its prev
(define (frame-entry f) (dict :txs (:txs f) :attempt (:attempt f) :author (:author f)))
(define (frame-hash f) (cons (frame-entry f) (:prev f)))
(define (frame-msg f) (dict :kind :frame :frame f))
(define (ack-msg h) (dict :kind :ack :hash h))
;; a refusal names the frame hash, the index of the first tx refused, the fault, and the receiver's mark
(define (refusal-msg f index fault mark) (dict :kind :refusal :hash (frame-hash f) :index index :fault fault :mark mark))
;; the faults that pass with the peer's view moving: the proposer retries them
(define (retryable? fault) (and (member fault (list :not_expired :deadline_too_far)) #t))

;; ---- validity: a tx is valid unless a conflicting predecessor is already committed ...
(define (committed r) (append-map (lambda (e) (:txs e)) (:head r)))
(define (committed-in-order r) (append-map (lambda (e) (:txs e)) (reverse (:head r))))
(define (tx-valid? before tx)
  (every (lambda (pair) (not (and (equal? (cadr pair) tx) (member (car pair) before)))) (conflict-pairs)))
;; ... and, for a clock-dependent tx, unless the judging party's view of the J clock refuses it
(define (tx-time-fault view tx)
  (cond ((member tx lock-txs)
         (cond ((<= lock-deadline view) :deadline_passed)
               ((> lock-deadline (+ view lock-horizon)) :deadline_too_far)
               (else #f)))
        ((member tx expire-txs) (if (<= view lock-deadline) :not_expired #f))
        (else #f)))
(define (tx-fault view before tx)
  (if (tx-valid? before tx) (tx-time-fault view tx) :tx_conflict))
;; each tx of a frame is checked against the history plus the txs ahead of it in the frame:
;; #f, or (index . fault) of the first tx refused
(define (frame-fault view before txs)
  (let loop ((rest txs) (before before) (i 0))
    (if (null? rest)
        #f
        (let ((fault (tx-fault view before (car rest))))
          (if fault
              (cons i fault)
              (loop (cdr rest) (append before (list (car rest))) (+ i 1)))))))

;; ---- one replica receiving one message -> (dict :replica :sent)
;; the head moves: the attempt and the refusal mark belong to a head, so both start again
(define (commit r head)
  (-> r (assoc-in (list :head) head) (assoc-in (list :pending) #f)
        (assoc-in (list :attempt) 0) (assoc-in (list :mark) #f)))
(define (roll-back r)
  (-> r (update-in (list :mempool) (lambda (m) (append (:txs (:pending r)) m)))
        (assoc-in (list :pending) #f)))

(define (ignore r) (dict :replica r :sent (list)))
(define (accept r f)
  (dict :replica (commit (if (:pending r) (roll-back r) r) (frame-hash f))
        :sent    (list (ack-msg (frame-hash f)))))

;; the receiver's mark: the highest attempt it refused on this head, with the fault. A frame
;; is only judged above the mark, so remembering overwrites.
(define (remember r f index fault)
  (assoc-in r (list :mark) (dict :attempt (:attempt f) :index index :fault fault)))
(define (refuse r f index fault mark)
  (dict :replica r :sent (list (refusal-msg f index fault mark))))
;; a frame at or below the mark is not judged: the same refusal again, or `stale_attempt`
(define (at-or-below-mark? r f) (and (:mark r) (<= (:attempt f) (:attempt (:mark r)))))
(define (answer-from-mark r f)
  (let ((m (:mark r)))
    (if (equal? (:attempt f) (:attempt m))
        (refuse r f (:index m) (:fault m) (:attempt m))
        (refuse r f 0 :stale_attempt (:attempt m)))))

(define (own-frame? side f) (equal? (:author f) side))
;; Left wins a same-height collision: Left, with a frame out, ignores the peer's frame
(define (keeps-own? side r) (and (:pending r) (equal? side :left)))
(define (extends-head? r f) (equal? (:prev f) (:head r)))
(define (reack? r f) (equal? (frame-hash f) (:head r)))

(define (on-next-frame side r f view)
  (cond
    ((at-or-below-mark? r f) (answer-from-mark r f))
    ((keeps-own? side r) (ignore r))
    (else
     (let ((bad (frame-fault view (committed-in-order r) (:txs f))))
       (if bad
           (refuse (remember r f (car bad) (cdr bad)) f (car bad) (cdr bad) (:attempt f))
           (accept r f))))))

(define (on-frame side r f view)
  (cond
    ((own-frame? side f) (ignore r))
    ((extends-head? r f) (on-next-frame side r f view))
    ((reack? r f) (dict :replica r :sent (list (ack-msg (frame-hash f)))))
    (else (ignore r))))

(define (on-ack r h)
  (if (and (:pending r) (equal? (frame-hash (:pending r)) h))
      (dict :replica (commit r h) :sent (list))
      (ignore r)))

;; a refusal of my pending frame: roll it back and set the next attempt to max(own, mark) + 1.
;; A stale answer costs no tx; a retryable fault within the budget costs none either (every tx
;; goes back, no notice); any other fault, or a spent budget, drops the named tx with notice.
(define (drop-named r i)
  (let* ((txs (:txs (:pending r))) (tx (list-ref txs i)))
    (-> r (update-in (list :mempool) (lambda (m) (append (take txs i) (list-tail txs (+ i 1)) m)))
          (update-in (list :refused) (lambda (x) (append x (list tx))))
          (assoc-in (list :pending) #f))))
;; the next attempt: past my own and past the receiver's mark
(define (next-attempt r m) (+ (max (:attempt r) (:mark m)) 1))
(define (handle-refusal r m)
  (let* ((fault (:fault m))
         (r2 (cond ((equal? fault :stale_attempt) (roll-back r))
                   ((and (retryable? fault) (< (:attempt r) max-attempt)) (roll-back r))
                   (else (drop-named r (:index m))))))
    (assoc-in r2 (list :attempt) (next-attempt r m))))
(define (on-refusal r m)
  (if (and (:pending r) (equal? (frame-hash (:pending r)) (:hash m))
           (< (:index m) (length (:txs (:pending r)))))
      (dict :replica (handle-refusal r m) :sent (list))
      (ignore r)))

(define (receive side r m view)
  (case (:kind m)
    ((:frame)   (on-frame side r (:frame m) view))
    ((:ack)     (on-ack r (:hash m)))
    ((:refusal) (on-refusal r m))))

;; ---- proposing: judge the mempool by the proposer's own view, refuse what no longer holds
;; `split-valid` is the conflict check alone (a property restates the committed history through it)
(define (split-valid before txs)
  (let loop ((rest txs) (before before) (ok (list)) (bad (list)))
    (cond ((null? rest) (dict :valid (reverse ok) :refused (reverse bad)))
          ((tx-valid? before (car rest))
           (loop (cdr rest) (append before (list (car rest))) (cons (car rest) ok) bad))
          (else (loop (cdr rest) before ok (cons (car rest) bad))))))

;; the proposer's own check of a tx against the head (a planted bug skips it)
(define (proposal-valid? before tx) (tx-valid? before tx))
;; the mempool in order: :valid go into the frame, :refused (a conflict, or a fault that does not pass)
;; are refused with notice, and :waiting (from the first tx whose fault is retryable) stays in the mempool
(define (split-proposal view before txs)
  (let loop ((rest txs) (before before) (ok (list)) (bad (list)))
    (if (null? rest)
        (dict :valid (reverse ok) :refused (reverse bad) :waiting (list))
        (let* ((tx (car rest))
               (fault (if (proposal-valid? before tx) (tx-time-fault view tx) :tx_conflict)))
          (cond ((not fault) (loop (cdr rest) (append before (list tx)) (cons tx ok) bad))
                ((retryable? fault) (dict :valid (reverse ok) :refused (reverse bad) :waiting rest))
                (else (loop (cdr rest) before ok (cons tx bad))))))))

(define (propose-from side r view)
  (let ((split (split-proposal view (committed-in-order r) (:mempool r))))
    (-> r
        (assoc-in (list :mempool) (:waiting split))
        (update-in (list :refused) (lambda (x) (append x (:refused split))))
        (assoc-in (list :pending)
                  (if (null? (:valid split))
                      #f
                      (dict :txs (:valid split) :prev (:head r) :attempt (:attempt r) :author side))))))
(define (can-propose? side r view)
  (and (not (:pending r)) (pair? (:mempool r))
       (let ((split (split-proposal view (committed-in-order r) (:mempool r))))
         (or (pair? (:valid split)) (pair? (:refused split))))))

;; ---- rules
;; a message already waiting on the link is not queued again: repeats come only from the
;; `duplicate` rule, which is budgeted (otherwise resend + re-ack grows the link forever)
(define (enqueue w side msgs)
  (update-in w (list :inbox side)
             (lambda (q) (append q (filter (lambda (m) (not (member m q))) msgs)))))
(define (enqueue-copy w side msg) (update-in w (list :inbox side) (lambda (q) (append q (list msg)))))
(define (inbox-of w side) (get-in w (list :inbox side)))
;; what reaches the link (the replay config that filters refusals out of it redefines this)
(define (keep-msg? m) #t)

;; a side's read of the J clock lags it by k
(define (view-at w k) (- (:clock w) k))

(define submit
  (rule "submit" (w side)
    (when (< (get-in w (list :count side)) (length (txs-of side))))
    (then (let ((tx (list-ref (txs-of side) (get-in w (list :count side)))))
            (-> w (update-in (list side :mempool) (lambda (m) (append m (list tx))))
                  (update-in (list :count side) (lambda (n) (+ n 1))))))))

;; the J clock moves on, between a frame's proposal and its receipt
(define tick
  (rule "J clock ticks" (w side)
    (when (and (equal? side :left) (< (:clock w) max-clock)))
    (then (update-in w (list :clock) (lambda (n) (+ n 1))))))

(define (lag-name base k) (if (= k 0) base (str base ", view lags " k)))

(define (propose-lag k)
  (rule (lag-name "propose" k) (w side)
    (when (and (>= (:clock w) k) (can-propose? side (side w) (view-at w k))))
    (then (let* ((r (propose-from side (side w) (view-at w k)))
                 (w2 (assoc-in w (list side) r)))
            (if (:pending r) (enqueue w2 (peer side) (list (frame-msg (:pending r)))) w2)))))

(define (deliver-lag k)
  (rule (lag-name "deliver" k) (w side)
    (when (and (>= (:clock w) k) (pair? (inbox-of w side))))
    (then (let ((out (receive side (side w) (car (inbox-of w side)) (view-at w k))))
            (-> w (assoc-in (list side) (:replica out))
                  (update-in (list :inbox side) cdr)
                  (enqueue (peer side) (filter keep-msg? (:sent out))))))))

;; a timeout: a proposer with a pending frame may send it again, unless that copy is
;; already on the link (so the state space stays finite)
(define resend
  (rule "resend" (w side)
    (when (and (get-in w (list side :pending))
               (not (member (frame-msg (get-in w (list side :pending))) (inbox-of w (peer side))))))
    (then (enqueue w (peer side) (list (frame-msg (get-in w (list side :pending))))))))

;; the link into `side` loses its next message / repeats it later
(define lose
  (rule "lose" (w side)
    (when (and (pair? (inbox-of w side)) (< (:lost w) max-losses)))
    (then (-> w (update-in (list :inbox side) cdr) (update-in (list :lost) (lambda (n) (+ n 1)))))))

(define duplicate
  (rule "duplicate" (w side)
    (when (and (pair? (inbox-of w side)) (< (:dups w) max-dups)))
    (then (-> w (enqueue-copy side (car (inbox-of w side))) (update-in (list :dups) (lambda (n) (+ n 1)))))))

;; a BYZANTINE proposer sends its whole mempool as one frame when that frame is invalid on its own (two
;; conflicting txs). Nothing about it enters the proposer's books: only the receiver's validation stands
;; between the frame and the history (bug `frame-order`). The forged frame is at attempt 0.
(define byz-frame
  (rule "byz frame" (w side)
    (when (and (< (:byz w) max-byz) (pair? (get-in w (list side :mempool)))
               (pair? (:refused (split-valid (list) (get-in w (list side :mempool)))))))
    (then (-> (enqueue w (peer side)
                       (list (frame-msg (dict :txs (get-in w (list side :mempool)) :prev (get-in w (list side :head))
                                              :attempt 0 :author side))))
              (update-in (list :byz) (lambda (n) (+ n 1)))))))

;; the link hands a replica its OWN pending frame back, as if the peer had sent it (frame author)
(define reflect
  (rule "reflect own frame" (w side)
    (when (and (< (:reflect w) max-reflect) (get-in w (list side :pending))))
    (then (-> (enqueue-copy w side (frame-msg (get-in w (list side :pending))))
              (update-in (list :reflect) (lambda (n) (+ n 1)))))))

(define (base-rules) (list submit tick resend lose duplicate byz-frame reflect))
(define (lag-rules)
  (append-map (lambda (k) (list (propose-lag k) (deliver-lag k))) (iota (+ view-lag 1))))
(define (all-rules) (append (base-rules) (lag-rules)))
(define (next w) (successors (all-rules) sides w))

;; ---- properties
(define (extends? long short)
  (and (>= (length long) (length short))
       (equal? (list-tail long (- (length long) (length short))) short)))
(define (held r) (append (committed r) (:mempool r) (:refused r) (if (:pending r) (:txs (:pending r)) (list))))
(define (submitted w side) (take (txs-of side) (get-in w (list :count side))))
(define (head-of w side) (get-in w (list side :head)))
(define (all-txs) (append (txs-of :left) (txs-of :right)))
(define (timed? tx) (or (member tx lock-txs) (member tx expire-txs)))

(define invariants
  (list
   (property "committed histories agree: one extends the other" (w)
     (or (extends? (head-of w :left) (head-of w :right))
         (extends? (head-of w :right) (head-of w :left))))
   (property "heights differ by at most one" (w)
     (<= (abs (- (length (head-of w :left)) (length (head-of w :right)))) 1))
   ;; Arrival's frames carried no author, so a replica could commit its own frame handed back as the peer's.
   ;; The author commits a frame only on the peer's ack, and the peer acks after it committed: so every frame a
   ;; replica holds as its own is already in the peer's history (R-FRAME-AUTHOR).
   (property "a replica commits its own frame only after the peer did (frame author)" (w)
     (every (lambda (side)
              (let ((head (head-of w side)))
                (every (lambda (i)
                         (or (not (equal? (:author (list-ref head i)) side))
                             (extends? (head-of w (peer side)) (list-tail head i))))
                       (iota (length head)))))
            sides))
   (property "no submitted tx is lost: committed, held, or refused" (w)
     (every (lambda (side) (every (lambda (tx) (member tx (held (side w)))) (submitted w side)))
            sides))
   (property "no tx committed twice" (w)
     (every (lambda (side)
              (let ((txs (committed (side w)))) (= (length txs) (length (delete-duplicates txs)))))
            sides))
   (property "each side's txs commit in submission order" (w)
     (every (lambda (side)
              (let ((mine (filter (lambda (tx) (member tx (txs-of side))) (committed-in-order (side w)))))
                (equal? mine (filter (lambda (tx) (member tx mine)) (txs-of side)))))
            sides))
   ;; restated through `split-valid`, not through `frame-fault` (a planted bug redefines that one)
   (property "no committed tx is invalid against the history before it" (w)
     (every (lambda (side) (null? (:refused (split-valid (list) (committed-in-order (side w)))))) sides))
   ;; a tx is refused only because a conflicting predecessor exists (one committed, or one ahead of it in
   ;; its own frame), or because it is clock-dependent. The predecessor may be rolled back afterwards (a
   ;; cross-open), and the refusal stays: final with notice, the sender resubmits (QUESTIONS Q-A-10). So the
   ;; check is on the pair, not on the state at the time of the check.
   (property "a refused tx has a conflicting predecessor among the submitted txs, or depends on the clock" (w)
     (every (lambda (side)
              (every (lambda (tx)
                       (or (timed? tx)
                           (some (lambda (pair) (and (equal? (cadr pair) tx)
                                                     (member (car pair) (append (submitted w :left) (submitted w :right)))))
                                 (conflict-pairs))))
                     (:refused (side w))))
            sides))
   (property "no tx is both committed and refused" (w)
     (every (lambda (side)
              (every (lambda (tx) (not (member tx (committed (side w))))) (:refused (side w))))
            sides))))

(define (done? w)
  (and (equal? (head-of w :left) (head-of w :right))
       (every (lambda (side) (and (not (get-in w (list side :pending)))
                                  (null? (get-in w (list side :mempool)))
                                  (null? (inbox-of w side))
                                  (= (get-in w (list :count side)) (length (txs-of side)))))
              sides)
       (= (+ (length (committed (:left w))) (length (:refused (:left w))) (length (:refused (:right w))))
          (length (all-txs)))))

(define at-rest
  (list (property "at rest: both sides committed the same history, every tx accounted for" (w) (done? w))))

(define account-frames
  (dict :init init :next next :invariants invariants :at-rest at-rest :goal done?))
