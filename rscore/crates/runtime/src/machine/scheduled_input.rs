use serde_json::{Map, Number, Value};
use xln_rscore_entity_kernel::{
    CanonicalEntityTx, ScheduledWake, ScheduledWakeJob, ScheduledWakeJobKind, SchedulerError,
    scheduled_wake_entity_tx,
};

fn entity_id_text(entity_id: [u8; 32]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in entity_id {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

pub(super) fn empty_entity_input(entity_id: [u8; 32], signer_id: &str) -> Value {
    Value::Object(Map::from_iter([
        (
            "entityId".to_string(),
            Value::String(entity_id_text(entity_id)),
        ),
        ("signerId".to_string(), Value::String(signer_id.to_string())),
        ("entityTxs".to_string(), Value::Array(Vec::new())),
    ]))
}

fn job_kind(kind: ScheduledWakeJobKind) -> &'static str {
    match kind {
        ScheduledWakeJobKind::Hook => "hook",
        ScheduledWakeJobKind::Task => "task",
    }
}

fn wake_data(wake: &ScheduledWake) -> Value {
    let jobs = wake
        .jobs
        .iter()
        .map(|job| {
            Value::Object(Map::from_iter([
                (
                    "kind".to_string(),
                    Value::String(job_kind(job.kind).to_string()),
                ),
                ("id".to_string(), Value::String(job.id.clone())),
                ("dueAt".to_string(), Value::Number(Number::from(job.due_at))),
            ]))
        })
        .collect();
    Value::Object(Map::from_iter([
        (
            "version".to_string(),
            Value::Number(Number::from(wake.version)),
        ),
        (
            "proposerSignerId".to_string(),
            Value::String(wake.proposer_signer_id.clone()),
        ),
        (
            "dueAt".to_string(),
            Value::Number(Number::from(wake.due_at)),
        ),
        ("jobs".to_string(), Value::Array(jobs)),
    ]))
}

fn invalid_recorded_wake(detail: &'static str) -> SchedulerError {
    SchedulerError::InvalidWake {
        detail: format!("RECORDED_{detail}"),
    }
}

fn exact_object_field<'a>(
    value: &'a xln_rscore_protocol::CanonicalValue,
    field_count: usize,
    field: &str,
) -> Result<&'a xln_rscore_protocol::CanonicalValue, SchedulerError> {
    let xln_rscore_protocol::CanonicalValue::Object(fields) = value else {
        return Err(invalid_recorded_wake("OBJECT"));
    };
    if fields.len() != field_count {
        return Err(invalid_recorded_wake("FIELDS"));
    }
    fields
        .iter()
        .find_map(|(name, value)| (name == field).then_some(value))
        .ok_or_else(|| invalid_recorded_wake("FIELDS"))
}

fn recorded_u64(value: &xln_rscore_protocol::CanonicalValue) -> Result<u64, SchedulerError> {
    let xln_rscore_protocol::CanonicalValue::Number(value) = value else {
        return Err(invalid_recorded_wake("NUMBER"));
    };
    value
        .as_str()
        .parse()
        .map_err(|_| invalid_recorded_wake("NUMBER"))
}

/// Decode the exact wake already present in a recorded Runtime input.
///
/// A recorded wake is allowed to become stale while waiting behind earlier
/// FIFO work. TypeScript validates only its signed shape and timestamp at the
/// Entity transition, then recomputes the actual due crontab commands from the
/// current pre-command Entity state. Requiring the diagnostic `jobs` list to
/// remain the current due set here would reject a canonical WAL after replay.
pub(super) fn decode_recorded_scheduled_wake(
    value: &xln_rscore_protocol::CanonicalValue,
) -> Result<ScheduledWake, SchedulerError> {
    let version = recorded_u64(exact_object_field(value, 4, "version")?)?
        .try_into()
        .map_err(|_| invalid_recorded_wake("VERSION"))?;
    let proposer_signer_id = match exact_object_field(value, 4, "proposerSignerId")? {
        xln_rscore_protocol::CanonicalValue::String(value) => value.clone(),
        _ => return Err(invalid_recorded_wake("PROPOSER")),
    };
    let due_at = recorded_u64(exact_object_field(value, 4, "dueAt")?)?;
    let jobs = match exact_object_field(value, 4, "jobs")? {
        xln_rscore_protocol::CanonicalValue::Array(jobs) => jobs,
        _ => return Err(invalid_recorded_wake("JOBS")),
    }
    .iter()
    .map(|job| {
        let kind = match exact_object_field(job, 3, "kind")? {
            xln_rscore_protocol::CanonicalValue::String(kind) if kind == "hook" => {
                ScheduledWakeJobKind::Hook
            }
            xln_rscore_protocol::CanonicalValue::String(kind) if kind == "task" => {
                ScheduledWakeJobKind::Task
            }
            _ => return Err(invalid_recorded_wake("JOB_KIND")),
        };
        let id = match exact_object_field(job, 3, "id")? {
            xln_rscore_protocol::CanonicalValue::String(id) => id.clone(),
            _ => return Err(invalid_recorded_wake("JOB_ID")),
        };
        let due_at = recorded_u64(exact_object_field(job, 3, "dueAt")?)?;
        Ok(ScheduledWakeJob { kind, id, due_at })
    })
    .collect::<Result<Vec<_>, SchedulerError>>()?;
    Ok(ScheduledWake {
        version,
        proposer_signer_id,
        due_at,
        jobs,
    })
}

/// Build both representations from one validated wake. The typed projection
/// feeds Entity certification; the tagged logical value is the exact
/// synthetic EntityInput persisted inside the enclosing RuntimeInput.
pub(super) fn scheduled_wake_entity_input(
    entity_id: [u8; 32],
    wake: &ScheduledWake,
) -> Result<(CanonicalEntityTx, Value), SchedulerError> {
    let tx = scheduled_wake_entity_tx(wake)?;
    let data = wake_data(wake);
    let canonical = Value::Object(Map::from_iter([
        (
            "entityId".to_string(),
            Value::String(entity_id_text(entity_id)),
        ),
        (
            "signerId".to_string(),
            Value::String(wake.proposer_signer_id.clone()),
        ),
        (
            "entityTxs".to_string(),
            Value::Array(vec![Value::Object(Map::from_iter([
                (
                    "type".to_string(),
                    Value::String("scheduledWake".to_string()),
                ),
                ("data".to_string(), data),
            ]))]),
        ),
    ]));
    Ok((tx, canonical))
}
