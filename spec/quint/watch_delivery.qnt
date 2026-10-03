// Slice 1: a delivery's ordinary facts, owed finalizations and view are one WAL record.
// Two finalizes belong to the same Account, in log order. Payload availability is external;
// decoding/authentication and deadline arithmetic are covered by their existing models/vectors.
module watch_delivery {
  type Facts = { view: int, pending: Set[int], ends: List[int], ordinary: int }
  pure val EMPTY = { view: 0, pending: Set(), ends: [], ordinary: 0 }
  var mem: Facts
  var disk: Facts
  var ready: Set[int]
  var phase: int

  action init = all { mem' = EMPTY, disk' = EMPTY, ready' = Set(), phase' = 0 }

  action readable(i: int): bool = all {
    ready' = ready.union(Set(i)), mem' = mem, disk' = disk, phase' = phase
  }

  // At view 0 the logs are fresh. At view 1 only the WAL's exact pending identities are owed.
  // A later finalize cannot dissolve the Account until the earlier one's payload was applied.
  action poll(ordered: bool): bool = {
    val owed = if (mem.view == 0) Set(1, 2) else mem.pending
    val released = owed.filter(i => ready.contains(i) and
      (not(ordered) or owed.filter(j => j < i).forall(j => ready.contains(j))))
    all {
      phase == 0,
      mem' = { view: 1, pending: owed.exclude(released),
        ends: mem.ends.concat([1, 2].foldl([], (xs, i) => if (released.contains(i)) xs.append(i) else xs)),
        ordinary: mem.ordinary + (if (mem.view == 0) 1 else 0) },
      disk' = disk, ready' = ready, phase' = 1
    }
  }

  // split=false is the repaired path. The split mutant keeps effects but not their view.
  action persist(split: bool): bool = all {
    phase == 1,
    disk' = if (split) mem.with("view", disk.view) else mem,
    mem' = mem, ready' = ready, phase' = 2
  }

  action finish = all { phase == 2, phase' = 0, mem' = mem, disk' = disk, ready' = ready }
  action crash = all { mem' = disk, phase' = 0, disk' = disk, ready' = ready }
  action step = any { readable(1), readable(2), poll(true), persist(false), finish, crash }

  pure def orderedOnce(f: Facts): bool = and {
    f.ordinary <= 1,
    f.ends == [] or f.ends == [1] or f.ends == [1, 2],
    f.ends.foldl(true, (safe, i) => safe and not(f.pending.contains(i)))
  }
  val safe = orderedOnce(mem) and orderedOnce(disk)

  run pendingSurvivesCrashTest = init.then(readable(2)).then(poll(true)).then(persist(false))
    .then(crash).expect(and { disk.pending == Set(1, 2), disk.ends == [], safe })
    .then(readable(1)).then(poll(true)).then(persist(false)).then(crash)
    .expect(and { disk.ends == [1, 2], disk.pending == Set(), disk.ordinary == 1, safe })

  run crashBeforePersistTest = init.then(readable(1)).then(poll(true)).then(crash)
    .expect(disk == EMPTY).then(poll(true)).then(persist(false)).then(crash)
    .expect(and { disk.ends == [1], disk.pending == Set(2), safe })

  run resolvedMarkerCrashTest = init.then(poll(true)).then(persist(false)).then(crash)
    .then(readable(1)).then(readable(2)).then(poll(true)).then(persist(false)).then(crash)
    .then(poll(true)).then(persist(false)).then(crash)
    .expect(and { disk.ends == [1, 2], disk.ordinary == 1, safe })

  // Retain both counterexamples as executable tests: weakening either guard must be visible.
  run R_HEIGHT_ORDER_splitCommitCounterexampleTest = init.then(poll(true)).then(persist(true)).then(crash)
    .then(readable(1)).then(poll(true)).expect(not(safe))

  run laterFinalizeCounterexampleTest = init.then(readable(2)).then(poll(false)).expect(not(safe))
}
