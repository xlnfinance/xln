# Remote checkout preservation

The canonical deploy Git block previously returned success while deleting both a
tracked owner edit and an untracked owner file. The exact production Git block
from `733542dfbe7c95dce1ea197699f4a8ba625d0814` reproduced that loss in real isolated
Git repositories: command exit0, preservation regression exit1 in0.390s.

The deploy script now inlines `scripts/deployment/prepare-remote-main.sh` before
installing artifacts or invoking any service action. It requires clean main,
rejects hidden index flags, verifies the requested commit belongs to fetched
main, and permits only fast-forward. It refuses ignored-file collisions and
preserves the configured Git remote. Repository creation, reset, clean and forced
branch replacement are removed from this path. An existing divergent or dirty
checkout requires explicit preservation/integration, not automatic erasure.

Run the real-Git regression:

```sh
bun test scripts/deployment/prepare-remote-main.test.ts
```

Result:7/7 tests,36 assertions,2.798s. Cases cover clean/idempotent fast-forward,
ignored operator data, tracked/untracked owner changes, both hidden index flags,
ignored-file collisions, divergent local main and detached HEAD.

The same helper bytes were executed through existing SSH access on xln.finance
with a20s remote bound and the pre-run HEAD as the requested target. It passed
in17.283s, preserving deployed HEAD`4dfabd621b913e9e79da315f33d21a1b9708778b` and the
configured origin. Only Git remote refs were fetched; source, processes,
credentials, artifacts and databases were unchanged. This verifies transport and
the real host guard, not a rollout or recovery of its broken old Anvil state.

[Commands, exits and hashes](results.json) and [original regression logs](regression-logs.tar.gz)
retain the failure and passing evidence. Full deployment, production React
artifact delivery, scoped obsolete-testnet reset, public-chain/rollback and soak
remain separate unfinished gates. No contract, Runtime or financial semantics
changed in this fix.
