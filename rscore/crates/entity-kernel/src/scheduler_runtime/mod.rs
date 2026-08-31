//! Deterministic execution of Entity crontab work.
//!
//! Runtime owns *when* to inject a `scheduledWake`; Entity consensus owns the
//! resulting mutation.  The diagnostic jobs carried by the wake are never an
//! execution authority: this module always recomputes the complete due set
//! from committed `CrontabState` and the supplied Entity timestamp.

mod execute;

pub(crate) use execute::validate_scheduled_wake;
pub use execute::{
    CrontabExecutionContext, MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS, ScheduledWake, ScheduledWakeJob,
    ScheduledWakeJobKind, SchedulerCommand, SchedulerError, SchedulerExecution,
    collect_due_scheduled_wake_jobs, execute_crontab, scheduled_wake_entity_tx,
};
