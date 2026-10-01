# Lanes, development and promotion to main

How pull requests move during the testnet stage. The coordinator decides this file's content; the CI thread keeps it in step with the workflows. The check names below are exact.

## Branches
- Pull requests target `development`. A pull request into `development` runs two fast checks, `One gate (tsc, rules, frozen, style)` and `One gate (bun test)`, plus `Lane label` once it is required.
- Every push to `development` and `main` runs the whole gate (three seeds, forge, Quint, the Arrival shards) and is never cancelled; a newer push waits as the one pending run. The aggregate `One gate` is the check to require on `main`.
- Merge commits only. Never force-push.

## Lanes
Since 2026-10-01 16:10 there are three lanes. Each has one writing thread and at most one open pull request, and `Lane label` enforces it.

- core (Account, Entity, Runtime): written by the kernel thread. The cut thread and the matching engine wait for it.
- chain (J, Host, contracts, e2e): written by the e2e thread. The transport thread and the J builder review.
- spec: written by the spec thread. The Arrival thread reviews.
- process (CI, infra, process files): exempt, any number of pull requests.

Every pull request into `development` carries exactly one of the labels `core`, `chain`, `spec` or `process`. `Lane label` fails a core, chain or spec pull request while an open pull request into `development` with a lower number (a draft counts) carries the same label; the first one opened holds the lane until it closes. Closing, relabelling or reopening a pull request runs the check again for the others, so a waiting pull request turns green without a push.

Threads start a slice only when the coordinator hands one out. Every pull request names the e2e step it moves (`testnet-e2e`, the run in `e2e/skeleton-status.md`), or says none for CI and process work.

## Promotion to main (snapshot)
A pull request whose head is the moving `development` branch is restarted, and its run in progress cancelled, by every merge into `development`. So `main` is promoted from a snapshot, a branch with a head that never moves. The merge thread does these steps.

1. Pick the sha S: the `development` tip whose own push run is green, or the newest tip worth waiting for. Short sha s = its first 9 characters.
2. Cut the snapshot: `git fetch origin development && git push origin <S>:refs/heads/promote/<s>`. The branch name must start with `promote/`.
3. Open a pull request from `promote/<s>` into `main`, titled "Promote development <s> to main", listing what it carries. It is not a lane pull request. It needs the checks the `main` ruleset requires (`One gate`).
4. `development` keeps taking merges; they do not touch the snapshot's run. Never push to a `promote/` branch. A run for a `promote/` branch is not cancelled by a second event either: the concurrency line of `build-and-test.yml` carries `!startsWith(github.head_ref, 'promote/')` (pinned by R-GATE-CI-SPLIT).
5. Red snapshot: fix on `development` through the normal pull requests, cut a new snapshot, close the old pull request, delete its branch and cancel its run by hand. One snapshot at a time.
6. Green snapshot: merge it with a merge commit, open a "main into development" pull request so `development` carries the merge commit, and delete the `promote/<s>` branch.
7. A snapshot run takes about 45 minutes (Arrival shard 0 is the long one). A pull request into `main` does not read the pass markers that pushes to `development` saved, so a snapshot that touches `spec/` runs Quint and Arrival; one that leaves `spec/` alone reads `main`'s markers.
