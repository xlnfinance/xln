use serde_json::{Map, Number, Value};
use xln_rscore_entity_kernel::{
    CanonicalEntityTx, ScheduledWake, ScheduledWakeJobKind, SchedulerError,
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
