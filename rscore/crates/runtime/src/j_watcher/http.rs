use serde_json::{Value, json};

use super::types::{JWatcherError, JsonRpc};

/// Blocking HTTPS JSON-RPC client for the watcher thread.
///
/// The watcher is external I/O and never runs inside the deterministic reducer.
/// Keeping one request in flight also makes response-id binding unambiguous.
pub struct HttpJsonRpc {
    endpoint: String,
    agent: ureq::Agent,
}

impl HttpJsonRpc {
    pub fn new(endpoint: impl Into<String>) -> Result<Self, JWatcherError> {
        let endpoint = endpoint.into();
        if !(endpoint.starts_with("http://") || endpoint.starts_with("https://")) {
            return Err(JWatcherError::Rpc("endpoint-scheme".into()));
        }
        Ok(Self {
            endpoint,
            agent: ureq::Agent::new_with_defaults(),
        })
    }
}

impl JsonRpc for HttpJsonRpc {
    fn call(&self, method: &str, params: Value) -> Result<Value, JWatcherError> {
        let request = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let mut response = self
            .agent
            .post(&self.endpoint)
            .send_json(&request)
            .map_err(|error| JWatcherError::Rpc(error.to_string()))?;
        let value: Value = response
            .body_mut()
            .read_json()
            .map_err(|error| JWatcherError::Rpc(error.to_string()))?;
        decode_response(value)
    }
}

fn decode_response(value: Value) -> Result<Value, JWatcherError> {
    let object = value
        .as_object()
        .ok_or_else(|| JWatcherError::RpcResponse("object".into()))?;
    if object.get("jsonrpc") != Some(&Value::String("2.0".into()))
        || object.get("id") != Some(&Value::Number(1.into()))
    {
        return Err(JWatcherError::RpcResponse("envelope".into()));
    }
    if let Some(error) = object.get("error") {
        return Err(JWatcherError::RpcResponse(error.to_string()));
    }
    object
        .get("result")
        .cloned()
        .ok_or_else(|| JWatcherError::RpcResponse("result".into()))
}
