//! Called exclusively by commands/live.rs in its existing writer loop.
use super::{
    commands::command::{self, CommandAdmission},
    transport::socket::AdapterQuery,
};
use serde_json::{Value, json};
use xln_rscore_runtime::{ResidentRuntimeService, RuntimeEntityInput};

pub fn dispatch(
    service: &mut ResidentRuntimeService,
    query: AdapterQuery,
    history_config: &mut xln_rscore_runtime::restore::ConcreteCheckpointConfiguration,
    routing_fees: &std::collections::BTreeMap<
        xln_rscore_runtime::RuntimeEntityKey,
        (u32, num_bigint::BigInt),
    >,
) -> Result<Value, String> {
    match query {
        AdapterQuery::AdoptCustody { owner } => {
            crate::runtime_adapter::custody::adoption::adopt(service, history_config, owner)
        }
        AdapterQuery::Session { lane_id } => {
            let replica = service.processor().replica().map_err(|e| e.to_string())?;
            let ready = service.delivery_ready();
            Ok(json!({"currentHeight":replica.state.height,
                "nextCommandSequence":command::next_sequence(replica,&lane_id)?,
                "commandReady":ready,"commandReadyReason":if ready{None}else{Some("RUNTIME_RESTORING")}}))
        }
        AdapterQuery::Read { path, query } => {
            if path.trim_matches('/') == "payment-routes" {
                service
                    .sync_committed()
                    .map_err(|e| format!("E_INTERNAL:{e}"))?;
                return super::views::payment_routes::read(service, &query, routing_fees);
            }
            crate::runtime_adapter::history::history_read::read_with_context(
                service,
                &path,
                &query,
                history_config,
            )
        }
        AdapterQuery::Send {
            lane_id,
            expires_at_ms,
            request,
        } => {
            if !service.delivery_ready() {
                return Err("E_COMMAND_PENDING:runtime restoring".into());
            }
            let admission = command::admit(
                service.processor().replica().map_err(|e| e.to_string())?,
                &lane_id,
                expires_at_ms,
                &request,
            )?;
            let marker = match admission {
                CommandAdmission::Observed(value) => return Ok(value),
                CommandAdmission::Apply(marker) => marker,
            };
            let inputs =
                crate::runtime_adapter::commands::send_input::entity_inputs(&request["input"])?
                    .iter()
                    .cloned()
                    .map(RuntimeEntityInput::decode)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| format!("E_BAD_QUERY:{e}"))?;
            let sequence = marker.sequence;
            let report = service
                .process_adapter_entity_inputs(inputs, marker)
                .map_err(|e| e.to_string())?
                .ok_or("RADAPTER_COMMAND_FRAME_MISSING")?;
            let height = report
                .commitments
                .as_ref()
                .ok_or("RADAPTER_COMMAND_COMMITMENT_MISSING")?
                .height;
            service.sync_committed().map_err(|e| e.to_string())?;
            Ok(json!({"height":height,"status":"observed","commandSequence":sequence}))
        }
        AdapterQuery::Control { action } => Err(format!(
            "E_BAD_QUERY:unsupported control:{}",
            action
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("missing")
        )),
    }
}
