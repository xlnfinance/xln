// XLN Runtime layer: what surrounds an Entity so that the Entity's own rules keep meaning something.
//
// The Runtime owns four things, and this module checks each against crashes and reordering:
//   1 delivery       inputs reach a frame from three sources: a peer's messages, chain events (J), local commands. The set that
//                    is due at a tick is applied as one frame in one canonical order, whatever order it arrived in [R-R1]. Peer
//                    frames come before chain events, so a frame the peer co-signed at the tick a dispute is read is in the
//                    evidence the Entity answers with (QUESTIONS E1).
//   2 clock          a frame opens only when there is an input due (the idle gate): an empty frame is not a frame [R-R1].
//   3 J watching     the chain events are read in order and each is applied exactly once, across crashes: the cursor moves
//                    with the state that applied the event, in one durable write [R-J1]. Every kind of event is read, the
//                    DisputeOpSkipped of a skipped dispute op (J2) among them [R7].
//   4 durability     one frame is three steps, apply in memory, make it durable, send: the order is the rule. A signed frame that
//                    leaves before it is durable can be re-derived differently after a crash, and then the Entity has signed two
//                    frames for one height: the counterparty holds proof against it. A command is acknowledged to its user only
//                    once durable.
//
// The Entity is abstracted to its input history: its state is the list of input keys it has applied, in order, and the signed frame it
// sends is (height, history). Two different histories at one height are an equivocation. What the Entity does with the inputs is
// entity.qnt; here only what can go wrong between an input arriving and an output leaving.
//
// Halt taxonomy [R-X1, Q-R1]: see QUESTIONS.md R2. Simulation only.
module runtime {
  // ---------------------------------------------------------------------------------------------------------
  // Parameters and domain model
  // ---------------------------------------------------------------------------------------------------------

  pure val NJ = 3                 // chain events that will happen
  pure val NP = 2                 // distinct peer messages
  pure val NC = 2                 // distinct local commands
  pure val MAXF = 4               // frames per run

  // an input is named by its key: peer message k has key k, chain event k has key 10 + k, command k has key 20 + k.
  // The canonical order of a frame is ascending key: the peer's messages first, then chain events, then commands.
  pure def pKey(k: int): int = k
  pure def jKey(k: int): int = 10 + k
  pure def cKey(k: int): int = 20 + k
  pure def isJ(key: int): bool = key >= 10 and key < 20
  pure def isCmd(key: int): bool = key >= 20
  pure def jIdx(key: int): int = key - 10

  type Out = { h: int, body: List[int] }            // a signed frame: its height and the whole history it commits to

  // what is durable, and what is only in memory
  type Mem = { applied: List[int], h: int, cursor: int, out: Out, hasOut: bool }
  type Phase = | Idle | Applied | Durable          // Idle: nothing in flight; Applied: in memory only; Durable: on disk, not yet sent

  var mem: Mem
  var disk: Mem                    // the persisted copy of `mem`
  var log: List[List[int]]         // durable: the batch each frame applied (to check the canonical order and the idle gate)
  var inbox: Set[int]              // volatile: keys waiting for the next frame
  var phase: Phase
  var jhead: int                   // chain: events emitted so far
  var net: Set[Out]                // every frame the peer has received
  var acked: Set[int]              // commands acknowledged to their user
  var frames: int

  pure val EMPTY: Mem = { applied: [], h: 0, cursor: 0, out: { h: 0, body: [] }, hasOut: false }

  // ---------------------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------------------

  // a list of keys in ascending order (Quint has no sort: pick the smallest until none is left)
  pure def sorted(s: Set[int]): List[int] =
    s.fold([], (acc, k) => acc.append(k)).foldl([], (acc, k) => {
      val smaller = acc.foldl(0, (n, x) => if (x < k) n + 1 else n)
      acc.slice(0, smaller).concat([k]).concat(acc.slice(smaller, acc.length()))
    })

  pure def has(l: List[int], k: int): bool = l.foldl(false, (a, x) => a or x == k)
  // The kind of chain event k, as the Runtime meets it. Every kind is a chain fact and goes through the same cursor: the watcher
  // does not choose which events to read. Kind 2 is DisputeOpSkipped (J2): our dispute start was skipped because a dispute is
  // already open. The Entity that sent the start waits for its outcome; the skip event is the only outcome it will ever get.
  // BatchFailed (J5) is another event of the same standing: a batch that failed at its nonce.
  pure def isSkipEvent(k: int): bool = k % 2 == 0

  pure def cursorOf(l: List[int]): int = l.foldl(0, (m, k) => if (isJ(k) and jIdx(k) > m) jIdx(k) else m)

  // ---------------------------------------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------------------------------------

  action init = all {
    mem' = EMPTY, disk' = EMPTY, log' = [], inbox' = Set(), phase' = Idle,
    jhead' = 0, net' = Set(), acked' = Set(), frames' = 0
  }

  // the chain emits its next event
  action chainEmit: bool = all {
    jhead < NJ,
    jhead' = jhead + 1,
    mem' = mem, disk' = disk, log' = log, inbox' = inbox, phase' = phase, net' = net, acked' = acked, frames' = frames
  }

  // the watcher offers the next chain event after the cursor (it can offer it again until it is applied)
  action watch: bool = all {
    mem.cursor < jhead,
    inbox' = inbox.union(Set(jKey(mem.cursor + 1))),
    mem' = mem, disk' = disk, log' = log, phase' = phase, jhead' = jhead, net' = net, acked' = acked, frames' = frames
  }

  // a peer message arrives (any number of times, in any order), or a local command
  action arrive(key: int): bool = all {
    not(isJ(key)),
    inbox' = inbox.union(Set(key)),
    mem' = mem, disk' = disk, log' = log, phase' = phase, jhead' = jhead, net' = net, acked' = acked, frames' = frames
  }

  // Step 1 of a frame: apply everything due, once, in canonical order. Inputs already applied are dropped, not applied again.
  action apply: bool = {
    val due = inbox.filter(k => not(has(mem.applied, k)))
    val batch = sorted(due)
    all {
      phase == Idle, due.size() > 0, frames < MAXF,
      val newApplied = mem.applied.concat(batch)
      mem' = { applied: newApplied, h: mem.h + 1, cursor: cursorOf(newApplied), out: { h: mem.h + 1, body: newApplied }, hasOut: true },
      log' = log.append(batch),
      inbox' = Set(), phase' = Applied, frames' = frames + 1,
      disk' = disk, jhead' = jhead, net' = net, acked' = acked
    }
  }

  // Step 2: the frame becomes durable, the cursor with it; commands it applied are acknowledged now.
  action persist: bool = all {
    phase == Applied,
    disk' = mem, phase' = Durable,
    acked' = acked.union(mem.applied.foldl(Set(), (a, k) => if (isCmd(k)) a.union(Set(k)) else a)),
    mem' = mem, log' = log, inbox' = inbox, jhead' = jhead, net' = net, frames' = frames
  }

  // Step 3: the signed frame leaves.
  action send: bool = all {
    phase == Durable,
    net' = net.union(Set(mem.out)), phase' = Idle,
    mem' = mem, disk' = disk, log' = log, inbox' = inbox, jhead' = jhead, acked' = acked, frames' = frames
  }

  // A crash and restart: memory and the inbox are lost, the durable copy is loaded, the last signed frame is sent again.
  // The log and the acknowledgements were durable when they were made.
  action crash: bool = all {
    mem' = disk, inbox' = Set(), phase' = Idle,
    net' = if (disk.hasOut) net.union(Set(disk.out)) else net,
    log' = log, disk' = disk, jhead' = jhead, acked' = acked, frames' = frames
  }

  action step = any {
    chainEmit, watch, apply, persist, send, crash,
    { nondet k = 1.to(NP).oneOf() arrive(pKey(k)) },
    { nondet k = 1.to(NC).oneOf() arrive(cKey(k)) }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------------------------------------

  // The Entity never signs two frames for one height.
  val no_equivocation: bool = net.forall(a => net.forall(b => a.h != b.h or a.body == b.body))

  // Every chain event is applied once, in order, with no gap: the durable history holds chain events 1..cursor exactly once.
  val exactly_once_j: bool = {
    val js = disk.applied.foldl([], (acc, k) => if (isJ(k)) acc.append(k) else acc)
    and {
      js.length() == disk.cursor,
      1.to(disk.cursor).forall(k => has(js, jKey(k))),
      disk.applied.foldl(true, (ok, k) => ok and disk.applied.foldl(0, (n, x) => if (x == k) n + 1 else n) == 1)
    }
  }

  // Every command acknowledged to its user is durable.
  val acked_durable: bool = acked.forall(k => has(disk.applied, k))

  // Every frame's batch is in canonical order and not empty (the idle gate).
  val canonical_frames: bool = log.foldl(true, (ok, b) => ok and b.length() > 0 and b == sorted(b.foldl(Set(), (a, k) => a.union(Set(k)))))

  // The durable history is the concatenation of the frame batches: replaying the log reproduces the state.
  val replay_equals: bool = disk.applied == log.foldl([], (acc, b) => acc.concat(b)) or phase != Idle

  val safe: bool = and { no_equivocation, exactly_once_j, acked_durable, canonical_frames }

  // Coverage witnesses (false on purpose: `quint run --invariant` must find a violating trace)
  val w_no_frame: bool = frames == 0
  val w_no_two_frames: bool = frames < 2
  val w_no_lost_frame: bool = not(frames > mem.h and phase == Idle)      // a crash threw away a frame that was applied in memory only
  val w_no_j_applied: bool = disk.cursor == 0
  val w_no_command_acked: bool = acked.size() == 0
  val w_no_resend: bool = not(net.exists(o => o.h == disk.h and o.h > 0 and phase == Idle and frames > disk.h))
}
