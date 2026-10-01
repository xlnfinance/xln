;; Bilateral Account frames: a description, not an implementation.
;;
;; Two replicas, :left and :right, and one link into each. A replica holds its committed
;; history (newest frame first), a mempool, at most one pending frame, and the txs it
;; refused. The frame hash is abstracted as the history itself: equal heads mean equal
;; hashes.
;;
;; The round: a replica proposes a frame of its mempool on top of its head; the peer
;; commits it and answers with an ack; the proposer commits on the ack.
;;
;; The rules that decide everything (sources in spec/QUESTIONS.md):
;;   - Same-height collision: LEFT WINS (Types.sol:150, Account.sol:732; lessons R-A1).
;;     Left ignores right's frame and keeps its own; right rolls its frame back (its txs go
;;     back ahead of its mempool), commits left's, and acks.
;;   - A frame that is not the next one is REFUSED, never fatal (lessons R-X1): a stale or
;;     future frame changes nothing. A duplicate of the frame at my head is answered with
;;     the same ack again, so a lost ack cannot wedge the proposer.
;;   - Re-validation: a tx is checked against the committed history when it is proposed.
;;     One that no longer holds (its `conflicts` predecessor was committed while it waited)
;;     is REFUSED with notice, into :refused; it is never silently lost.
;;   - The link may lose and duplicate messages (bounded budgets); a proposer with a
;;     pending frame may always resend it (a timeout, abstracted as "at any time").
;;
;; Abstractions (what this page does NOT cover):
;;   - a receiver commits a frame when it arrives; xln.ts holds it as a `received`
;;     candidate first;
;;   - a frame and its ack are separate messages (xln.ts can ride an ack on the next frame);
;;   - the link is FIFO: messages are lost or duplicated, never reordered;
;;   - frame content is a list of txs whose only meaning is the `conflicts` relation; there
;;     is no ledger yet, so a bad hanko and a bad state root are not modelled;
;;   - a Byzantine proposer (a frame that is invalid on content) is refused by the same
;;     path as a stale one; it is not a separate rule.
;;
;; Needs lib/vocabulary.scm (rule, property) and lib/check.scm (successors).

;; ---- model bounds: declared, typed inputs of this page
(define/overridable left-txs   (s/array (s/string)) (list "a"))
(define/overridable right-txs  (s/array (s/string)) (list "x" "y"))
;; (earlier later): `later` is invalid once `earlier` is committed
(define/overridable conflicts  (s/array (s/array (s/string))) (list (list "a" "x")))
(define/overridable max-losses (s/number) 1)
(define/overridable max-dups   (s/number) 1)
;; frames a Byzantine proposer forges: its whole mempool as one frame, whatever it holds
(define/overridable max-byz    (s/number) 1)

;; ---- the world
(define sides (list :left :right))
(define (peer side) (if (equal? side :left) :right :left))
(define (txs-of side) (vector->list (if (equal? side :left) left-txs right-txs)))
(define (conflict-pairs) (map vector->list (vector->list conflicts)))
(define (replica) (dict :head (list) :mempool (list) :pending #f :refused (list)))
(define init
  (dict :left   (replica)
        :right  (replica)
        :inbox  (dict :left (list) :right (list))
        :unsent (dict :left (txs-of :left) :right (txs-of :right))
        :lost   0
        :dups   0
        :byz    0))

;; ---- frames and messages
(define (frame-hash f) (cons (:txs f) (:prev f)))
(define (frame-msg f) (dict :kind :frame :frame f))
(define (ack-msg h) (dict :kind :ack :hash h))

;; ---- validity: a tx is valid unless a conflicting predecessor is already committed
(define (committed r) (append-map (lambda (frame) frame) (:head r)))
(define (committed-in-order r) (append-map (lambda (frame) frame) (reverse (:head r))))
(define (tx-valid? before tx)
  (every (lambda (pair) (not (and (equal? (cadr pair) tx) (member (car pair) before)))) (conflict-pairs)))
;; each tx of a frame is checked against the history plus the txs ahead of it in the frame
(define (frame-valid? before txs)
  (or (null? txs)
      (and (tx-valid? before (car txs))
           (frame-valid? (append before (list (car txs))) (cdr txs)))))

;; ---- one replica receiving one message -> (dict :replica :sent)
(define (commit r head) (-> r (assoc-in (list :head) head) (assoc-in (list :pending) #f)))
(define (roll-back r)
  (-> r (update-in (list :mempool) (lambda (m) (append (:txs (:pending r)) m)))
        (assoc-in (list :pending) #f)))

(define (ignore r) (dict :replica r :sent (list)))
(define (accept r f)
  (dict :replica (commit (if (:pending r) (roll-back r) r) (frame-hash f))
        :sent    (list (ack-msg (frame-hash f)))))

(define (on-frame side r f)
  (cond
    ((equal? (:prev f) (:head r))
     (cond
       ((and (:pending r) (equal? side :left)) (ignore r))
       ((not (frame-valid? (committed-in-order r) (:txs f))) (ignore r))
       (else (accept r f))))
    ((equal? (frame-hash f) (:head r)) (dict :replica r :sent (list (ack-msg (frame-hash f)))))
    (else (ignore r))))

(define (on-ack r h)
  (if (and (:pending r) (equal? (frame-hash (:pending r)) h))
      (dict :replica (commit r h) :sent (list))
      (ignore r)))

(define (receive side r m)
  (case (:kind m)
    ((:frame) (on-frame side r (:frame m)))
    ((:ack)   (on-ack r (:hash m)))))

;; ---- proposing: validate the mempool against the head, refuse what no longer holds
(define (split-valid before txs)
  (let loop ((rest txs) (before before) (ok (list)) (bad (list)))
    (cond ((null? rest) (dict :valid (reverse ok) :refused (reverse bad)))
          ((tx-valid? before (car rest))
           (loop (cdr rest) (append before (list (car rest))) (cons (car rest) ok) bad))
          (else (loop (cdr rest) before ok (cons (car rest) bad))))))

(define (propose-from r)
  (let ((split (split-valid (committed-in-order r) (:mempool r))))
    (-> r
        (assoc-in (list :mempool) (list))
        (update-in (list :refused) (lambda (x) (append x (:refused split))))
        (assoc-in (list :pending)
                  (if (null? (:valid split)) #f (dict :txs (:valid split) :prev (:head r)))))))

;; ---- rules
;; a message already waiting on the link is not queued again: repeats come only from the
;; `duplicate` rule, which is budgeted (otherwise resend + re-ack grows the link forever)
(define (enqueue w side msgs)
  (update-in w (list :inbox side)
             (lambda (q) (append q (filter (lambda (m) (not (member m q))) msgs)))))
(define (enqueue-copy w side msg) (update-in w (list :inbox side) (lambda (q) (append q (list msg)))))
(define (inbox-of w side) (get-in w (list :inbox side)))

(define submit
  (rule "submit" (w side)
    (when (pair? (get-in w (list :unsent side))))
    (then (let ((tx (car (get-in w (list :unsent side)))))
            (-> w (update-in (list side :mempool) (lambda (m) (append m (list tx))))
                  (update-in (list :unsent side) cdr))))))

(define propose
  (rule "propose" (w side)
    (when (and (not (get-in w (list side :pending)))
               (pair? (get-in w (list side :mempool)))))
    (then (let* ((r (propose-from (side w)))
                 (w2 (assoc-in w (list side) r)))
            (if (:pending r) (enqueue w2 (peer side) (list (frame-msg (:pending r)))) w2)))))

(define deliver
  (rule "deliver" (w side)
    (when (pair? (inbox-of w side)))
    (then (let ((out (receive side (side w) (car (inbox-of w side)))))
            (-> w (assoc-in (list side) (:replica out))
                  (update-in (list :inbox side) cdr)
                  (enqueue (peer side) (:sent out)))))))

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
;; between the frame and the history (bug `frame-order`).
(define byz-frame
  (rule "byz frame" (w side)
    (when (and (< (:byz w) max-byz) (pair? (get-in w (list side :mempool)))
               (pair? (:refused (split-valid (list) (get-in w (list side :mempool)))))))
    (then (-> (enqueue w (peer side) (list (frame-msg (dict :txs (get-in w (list side :mempool)) :prev (get-in w (list side :head))))))
              (update-in (list :byz) (lambda (n) (+ n 1)))))))

(define rules (list submit propose deliver resend lose duplicate byz-frame))
(define (next w) (successors rules sides w))

;; ---- properties
(define (extends? long short)
  (and (>= (length long) (length short))
       (equal? (list-tail long (- (length long) (length short))) short)))
(define (held r) (append (committed r) (:mempool r) (:refused r) (if (:pending r) (:txs (:pending r)) (list))))
(define (submitted w side)
  (let ((all (txs-of side)))
    (take all (- (length all) (length (get-in w (list :unsent side)))))))
(define (head-of w side) (get-in w (list side :head)))
(define (all-txs) (append (txs-of :left) (txs-of :right)))

(define invariants
  (list
   (property "committed histories agree: one extends the other" (w)
     (or (extends? (head-of w :left) (head-of w :right))
         (extends? (head-of w :right) (head-of w :left))))
   (property "heights differ by at most one" (w)
     (<= (abs (- (length (head-of w :left)) (length (head-of w :right)))) 1))
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
   ;; restated through `split-valid`, not through `frame-valid?` (a planted bug redefines that one)
   (property "no committed tx is invalid against the history before it" (w)
     (every (lambda (side) (null? (:refused (split-valid (list) (committed-in-order (side w)))))) sides))
   ;; a tx is refused only because a conflicting predecessor exists: one committed, or one ahead of it in
   ;; its own frame. The predecessor may be rolled back afterwards (a cross-open), and the refusal stays:
   ;; final with notice, the sender resubmits (QUESTIONS Q-A-10). So the check is on the pair, not on
   ;; the state at the time of the check.
   (property "a refused tx has a conflicting predecessor among the submitted txs" (w)
     (every (lambda (side)
              (every (lambda (tx)
                       (some (lambda (pair) (and (equal? (cadr pair) tx)
                                                 (member (car pair) (append (submitted w :left) (submitted w :right)))))
                             (conflict-pairs)))
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
                                  (null? (get-in w (list :unsent side)))))
              sides)
       (= (+ (length (committed (:left w))) (length (:refused (:left w))) (length (:refused (:right w))))
          (length (all-txs)))))

(define at-rest
  (list (property "at rest: both sides committed the same history, every tx accounted for" (w) (done? w))))

(define account-frames
  (dict :init init :next next :invariants invariants :at-rest at-rest :goal done?))
