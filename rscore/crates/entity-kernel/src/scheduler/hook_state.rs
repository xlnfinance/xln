use super::{CrontabState, ScheduledHook};

/// Replace-or-create one deterministic hook by its stable identifier.
pub fn schedule_hook(state: &mut CrontabState, hook: ScheduledHook) {
    state.hooks.insert(hook.id.clone(), hook);
}

/// Remove a hook if it still exists. Repeated cancellation is intentionally
/// idempotent, matching the TypeScript scheduler boundary.
pub fn cancel_hook(state: &mut CrontabState, hook_id: &str) {
    state.hooks.remove(hook_id);
}
