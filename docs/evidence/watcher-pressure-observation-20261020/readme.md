# Retained RPC pressure observation

The exact unit command failed at the retained-pressure gate after authenticating
blocks 1–63. Three deliberate missing-header responses and one deliberately held
HTTP batch set the existing transport backoff to eight seconds. One successful
poll reduces it to six seconds. The test started its five-second RPC gate timer
after `processRuntime()`, which the isolated profiler measured at 762 ms. The
remaining cooldown was about 5,238 ms, so the observer expired before the next
request was allowed. Faster empty-worker startup exposed this timing dependency.

The fixture now observes its existing 1,400 ms minimum pressure interval before
starting the unchanged five-second gate timer. It captures the actual gate-entry
time, so an early request still fails even while the observer waits. Gate release
ownership, scan heights, real HTTP timeout, reorg and recovery assertions remain.
The canonical watcher and its pacing policy are unchanged.

[proof.json](proof.json) retains the failed full command and isolated reproduction.
The exact pressure case then passed 1/1 with 56 assertions in 55.88 seconds; the
separate 4,700-block authenticated backlog case passed 1/1 with 38 assertions in
36.75 seconds. Both retained their 60-second limit. Full immutable-SHA commands,
financial certification, browser coverage, release, soak and public verification
remain required; these focused results are not release approval.
