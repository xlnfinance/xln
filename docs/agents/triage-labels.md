# Triage labels

These canonical roles map directly to the local `Status:` values of implementation
tickets and triaged requests. Operations are defined in
[issue-tracker.md](issue-tracker.md).

| Skill role        | Local status      | Meaning                           |
| ----------------- | ----------------- | --------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer evaluation needed      |
| `needs-info`      | `needs-info`      | Reporter information needed       |
| `ready-for-agent` | `ready-for-agent` | Specified and ready for an agent  |
| `ready-for-human` | `ready-for-human` | Human action or decision required |
| `wontfix`         | `wontfix`         | Request will not be actioned      |

A triaged request has one category (`bug` or `enhancement`) and one state.
Wayfinding decision tickets use their own lifecycle from issue-tracker.md.
Completion and dependency resolution are recorded independently of triage roles.
