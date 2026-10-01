;; The node-to-node link (slice T0, decision D12): how one node's outputs reach another node's Runtime,
;; and what the receiver does with each message. A description of the boundary, not of a product:
;; the page names the interface and the assumptions; WebSocket, relay and gossip are implementations of it.
;;
;; WHAT A MESSAGE IS. One of two things, both addressed to an ENTITY (not to a socket):
;;   - an Account input (propose, ack, ack_frame, dispute, board_hanko_refresh; `AccountPeerInput` in pure/xln.ts),
;;     carried as an Entity output `{to, tx: accountInput}`;
;;   - an Entity input (proposal, precommit, leaderTimeoutVote, jPrefixAttestations), carried as
;;     `{to, signerId, input}` to one validator replica. (`txs` is the Entity's local input lane, stamped with the Host's own
;;     clock; a peer does not send it.)
;;   Every message is the output of a committed Runtime frame (R-DURABLE). Its body is self-authenticating: a frame carries
;;   its Hanko, a precommit its signatures. The link adds a sender check, but safety does not rest on it.
;;
;; WHAT THE LINK MAY DO TO A MESSAGE (the assumed channel, the weakest one): lose it, deliver it twice or more, deliver it
;; in any order, delay it without bound, misroute it, and let a stranger put messages on it. It is a bag of messages.
;; It promises no order, no exactly-once, no receipt and no timing.
;;
;; WHAT THE PAGE CHECKS. One sender `a` with a WAL of frames (frame h is the h-th committed row) and one receiver `b`:
;;   the receiver takes frame h when it is its next frame (h = applied + 1), commits the row, and only then acks it; it answers
;;   a duplicate with the ack of its head and REFUSES everything else in place, never halting (R-X1). The sender resends what
;;   is not acked. A cumulative ack is the only receipt, and it is an Account message, not a transport one (no rejection, no
;;   delivery receipt exists). Both sides persist before anything leaves (R-DURABLE): the sender's frame leaves only from a
;;   committed row, the receiver's ack only after its row is committed. A node that halts takes no further step.
;;
;;   emit       the sender builds frame n+1.
;;   persist    the row is committed (the boundary with the Runtime: R-DURABLE).
;;   send       a committed, unacked frame goes to the address the directory gives for the peer.
;;   refresh    the sender re-resolves its peer's address (it starts with a stale entry, which reaches a node that refuses it).
;;   crash      the sender loses its volatile state (the unpersisted frame, the belief about acks); the WAL and the channel survive.
;;              A frame built again after a crash has another body (the body carries the crash count), so an equivocation
;;              shows.
;;   b persist  the receiver commits the frame it holds and acks it. b crash: a frame it holds but has not committed is lost.
;;   deliver    the receiver (or sender, for an ack) handles one message; the message STAYS on the channel, so it may be
;;              delivered again (duplication) and later than anything sent after it (reordering).
;;   drop       a message is lost (a delivery followed by a drop is the ordinary single delivery).
;;   forge      a stranger puts a frame or an ack on the channel, claiming the sender's or receiver's name (height 1).
;;
;; "Can always still finish" (the checker's liveness) means NO REACHABLE DEAD END: from every reachable world some run completes.
;; Under unbounded loss that is the most that can be said; it is not progress under fairness.
;;
;; Bounds, accepted (spec/QUESTIONS.md Q-T-10): two frames, one crash of each node, one forgery. A three-frame pipeline is where exhaustive
;; search runs out; it goes to Quint later.
;;
;; Abstractions: one sender, one receiver, one Account stream; the frame body is a string and a height; the signature is the
;; flag `ok` or `forged`; the directory is one entry, the receiver's address `b` or a stale `old` (a frame sent to `old` reaches
;; a node that is not the peer, which refuses it: the frame is gone and nothing else changes); the receiver persists its
;; own row before its ack leaves (rules `b persist` and `b crash`); the world keeps no record of refusals (the witnesses add one,
;; transport/configs/recording-refuse.scm); encryption, size limits, rate limits and the
;; WebSocket session fence are not modelled. Loss and duplication are unbounded (a message stays on the channel after a delivery),
;; so no budget of losses or duplicates hides a case.
;;
;; In v1 each peer gets a bounded inbound queue and anything over the bound is dropped: that is loss, which the page already has.
;; Not in the page: a second Account stream, several validators, encryption and size caps, the J watcher, a
;; relay (see spec/QUESTIONS.md, Q-T-10).
;;
;; Needs lib/vocabulary.scm and lib/check.scm.

(define/overridable max-frames (s/number) 2)
(define/overridable max-forgeries (s/number) 1)
(define/overridable max-crashes (s/number) 1)   ; of each node

(define sides (list :net))

;; a message: (kind src dst height body sig); kind is frame | ack, sig is ok | forged
(define (msg kind src dst h body sig) (list kind src dst h body sig))
(define (m-kind m) (car m))
(define (m-dst m) (caddr m))
(define (m-h m) (cadddr m))
(define (m-body m) (car (cddddr m)))
(define (m-sig m) (cadr (cddddr m)))

(define init
  (dict :wal (list)              ; the sender's committed frames: (body ...), frame h is the h-th
        :staged #f               ; a frame built, not yet committed
        :acked 0                 ; the sender's belief: how many frames the peer holds (volatile)
        :dir "old"               ; where the sender believes the peer is
        :chan (list)             ; messages on the link, a set kept sorted
        :bstaged #f              ; a frame the receiver holds and has not committed
        :applied (list)          ; the receiver's committed frames: (body ...)
        :halted #f               ; #f, or the node a peer message halted
        :forgeries 0 :crashes 0 :bcrashes 0))

;; ---- the channel
(define (insert-sorted x xs less?)
  (cond ((null? xs) (list x))
        ((equal? x (car xs)) xs)
        ((less? x (car xs)) (cons x xs))
        (else (cons (car xs) (insert-sorted x (cdr xs) less?)))))
(define (put w m)
  (update-in w (list :chan) (lambda (c) (insert-sorted m c (lambda (p q) (string<? (canon p) (canon q)))))))
(define (take-out w m) (update-in w (list :chan) (lambda (c) (filter (lambda (x) (not (equal? x m))) c))))
;; a refusal changes nothing: the reason names it for the reader, and the witnesses override `refuse` to record it (the world has no refusal record)
(define (refuse w reason) w)

;; ---- what a receiver does with a message: apply it, answer it, or refuse it in place. Never halt (R-X1).
;; The sender check: a frame or an ack is believed to come from its sender only when its signature is the sender's.
(define (frame-authentic? m) (equal? (m-sig m) "ok"))
(define (ack-authentic? m) (equal? (m-sig m) "ok"))

(define (put-ack w n) (put w (msg "ack" "b" "a" n "-" "ok")))

;; the receiver: frame h is taken only as its next frame and held until its row is committed (`b persist`), which is when it is
;; acked; a duplicate of a committed frame is answered with the ack of the head
(define (hold w m) (if (:bstaged w) w (assoc-in w (list :bstaged) (m-body m))))
(define (receive-frame w m)
  (let ((h (m-h m)) (n (length (:applied w))))
    (cond ((= h (+ n 1)) (hold w m))
          ((<= h n) (put-ack w n))
          (else (refuse w "future")))))

;; every message addressed to the receiver is a frame, and every message addressed to the sender is an ack (the channel carries
;; nothing else), so there is no "unexpected kind" branch
(define (b-receive w m)
  (if (frame-authentic? m) (receive-frame w m) (refuse w "forged")))

;; the sender: a cumulative ack raises its belief
(define (a-receive w m)
  (if (ack-authentic? m) (assoc-in w (list :acked) (max (:acked w) (m-h m))) (refuse w "forged")))

(define (handle w m)
  (if (equal? (m-dst m) "a") (a-receive w m) (b-receive w m)))

;; ---- the sender
(define (frames-to w) (iota max-frames 1))
;; the body of frame h the sender may put on the link, or #f: only a COMMITTED row (R-DURABLE)
(define (sendable-body w h) (and (<= h (length (:wal w))) (list-ref (:wal w) (- h 1))))
;; a frame sent to a stale address reaches a node that is not the peer: it refuses it, and nothing else happens
(define (send-frame w h)
  (if (equal? (:dir w) "b")
      (put w (msg "frame" "a" "b" h (sendable-body w h) "ok"))
      (refuse w "misrouted")))

;; the body of frame h is h and the sender's crash count: a frame built again after a crash is another frame, so the page can tell
;; an equivocation from a resend
(define emit
  (rule "emit" (w side)
    (when (and (not (:staged w)) (< (length (:wal w)) max-frames)))
    (then (assoc-in w (list :staged) (str "f" (+ (length (:wal w)) 1) "e" (:crashes w))))))
(define persist
  (rule "persist" (w side)
    (when (:staged w))
    (then (-> w (update-in (list :wal) (lambda (l) (append l (list (:staged w)))))
                (assoc-in (list :staged) #f)))))
(define (send-rule h)
  (rule (str "send " h) (w side)
    (when (and (sendable-body w h) (> h (:acked w))))
    (then (send-frame w h))))
(define b-persist
  (rule "b persist" (w side)
    (when (:bstaged w))
    (then (put-ack (-> w (update-in (list :applied) (lambda (l) (append l (list (:bstaged w)))))
                         (assoc-in (list :bstaged) #f))
                   (+ (length (:applied w)) 1)))))
(define b-crash
  (rule "b crash" (w side)
    (when (< (:bcrashes w) max-crashes))
    (then (-> w (update-in (list :bcrashes) (lambda (n) (+ n 1)))
                (assoc-in (list :bstaged) #f)))))
(define refresh
  (rule "refresh" (w side)
    (when (not (equal? (:dir w) "b")))
    (then (assoc-in w (list :dir) "b"))))
(define crash
  (rule "crash" (w side)
    (when (< (:crashes w) max-crashes))
    (then (-> w (update-in (list :crashes) (lambda (n) (+ n 1)))
                (assoc-in (list :staged) #f)
                (assoc-in (list :acked) 0)))))

;; ---- a stranger
(define forge-frame
  (rule "forge frame" (w side)
    (when (< (:forgeries w) max-forgeries))
    (then (-> (put w (msg "frame" "a" "b" 1 "z" "forged"))
              (update-in (list :forgeries) (lambda (n) (+ n 1)))))))
(define forge-ack
  (rule "forge ack" (w side)
    (when (< (:forgeries w) max-forgeries))
    (then (-> (put w (msg "ack" "b" "a" 1 "-" "forged"))
              (update-in (list :forgeries) (lambda (n) (+ n 1)))))))

;; ---- the channel's own moves: any message, any time, in any order
(define (net-step label name w2) (dict :label label :name name :side :net :world w2))
(define (net-steps w)
  (append-map (lambda (m)
                (list (net-step (str "deliver " (canon m)) "deliver" (handle w m))
                      (net-step (str "drop " (canon m)) "drop" (take-out w m))))
              (:chan w)))

(define (rules)
  (append (list emit persist refresh crash b-persist b-crash forge-frame forge-ack)
          (map send-rule (frames-to (:wal init)))))
;; a halted node takes no further step: the world is a dead end, which the liveness check sees
(define (next w) (if (:halted w) (list) (append (successors (rules) sides w) (net-steps w))))

;; ---- properties
;; two lists agree as far as both go: neither contradicts the other
(define (compatible? xs ys)
  (or (null? xs) (null? ys) (and (equal? (car xs) (car ys)) (compatible? (cdr xs) (cdr ys)))))

(define invariants
  (list
   (property "the receiver's frames are never contradicted by the sender's committed frames: no equivocation, and nothing forged, repeated or reordered was applied (P4, R-DURABLE)" (w)
     (compatible? (:applied w) (:wal w)))
   (property "the sender never believes the peer holds more than the peer applied: only a genuine ack moves the belief" (w)
     (<= (:acked w) (length (:applied w))))
   (property "no peer message halts a node: a refusal changes nothing and never stops the Runtime (R-X1; a halt is also a dead end for liveness)" (w)
     (not (:halted w)))))

;; done: every frame committed, applied by the receiver, and known to be by the sender
(define (finished? w)
  (and (not (:staged w)) (not (:bstaged w))
       (= (length (:wal w)) max-frames)
       (equal? (:applied w) (:wal w))
       (= (:acked w) max-frames)))

(define transport (dict :init init :next next :invariants invariants :at-rest (list) :goal finished?))
