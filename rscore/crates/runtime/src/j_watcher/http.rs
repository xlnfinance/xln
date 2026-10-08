use serde_json::{Value, json};

use super::types::{JWatcherError, JsonRpc};

/// Blocking HTTPS JSON-RPC client for the watcher thread.
///
/// The watcher is external I/O and never runs inside the deterministic reducer.
/// Keeping one request in flight also makes response-id binding unambiguous.
pub struct HttpJsonRpc {
    endpoint: String,
    agent: ureq::Agent,
    tron_solidity_endpoint: Option<String>,
    tron_full_endpoint: Option<String>,
}

impl HttpJsonRpc {
    pub fn new(endpoint: impl Into<String>) -> Result<Self, JWatcherError> {
        let endpoint = endpoint.into();
        if !(endpoint.starts_with("http://") || endpoint.starts_with("https://")) {
            return Err(JWatcherError::Rpc("endpoint-scheme".into()));
        }
        Ok(Self {
            endpoint,
            tron_solidity_endpoint: None,
            tron_full_endpoint: None,
            agent: ureq::Agent::new_with_defaults(),
        })
    }
    pub(crate) fn for_committed_j(
        endpoint: &str,
        row: &serde_json::Map<String, Value>,
    ) -> Result<Self, JWatcherError> {
        let mut rpc = Self::new(endpoint)?;
        match row.get("watcherReceiptCommitment") {
            None => {}
            Some(Value::String(policy)) if policy == "tron-rpc-attested" => {
                if row.get("watcherConfirmationDepth").and_then(Value::as_u64) != Some(0) {
                    return Err(JWatcherError::RpcResponse("TRON_FINALITY_DEPTH".into()));
                }
                let (full, solid) = super::tron::transport_endpoints(row, endpoint)?;
                rpc.tron_full_endpoint = Some(full);
                rpc.tron_solidity_endpoint = Some(solid);
            }
            Some(_) => return Err(JWatcherError::RpcResponse("RECEIPT_POLICY_INVALID".into())),
        }
        Ok(rpc)
    }

    fn solidified_head(&self, endpoint: &str) -> Result<Value, JWatcherError> {
        let mut response = self
            .agent
            .post(endpoint)
            .send_json(json!({}))
            .map_err(|e| JWatcherError::Rpc(e.to_string()))?;
        let native: Value = response
            .body_mut()
            .read_json()
            .map_err(|e| JWatcherError::RpcResponse(e.to_string()))?;
        let height = super::receipt::safe_u64(
            native
                .pointer("/block_header/raw_data/number")
                .ok_or_else(|| JWatcherError::RpcResponse("TRON_SOLIDIFIED_HEIGHT".into()))?,
            "solidifiedHeight",
        )?;
        let block = self.call(
            "eth_getBlockByNumber",
            json!([format!("0x{height:x}"), false]),
        )?;
        super::tron::validate_solidified_block(&native, &block)?;
        Ok(json!(format!("0x{height:x}")))
    }
}

impl JsonRpc for HttpJsonRpc {
    fn tron_rpc_attested(&self) -> bool {
        self.tron_solidity_endpoint.is_some()
    }
    fn tron_call(&self, method: &str, params: Value) -> Result<Value, JWatcherError> {
        let host = self
            .tron_full_endpoint
            .as_ref()
            .ok_or_else(|| JWatcherError::RpcResponse("TRON_NATIVE_TRANSPORT_REQUIRED".into()))?;
        if method.is_empty() || !method.bytes().all(|b| b.is_ascii_lowercase()) {
            return Err(JWatcherError::RpcResponse("TRON_NATIVE_METHOD".into()));
        }
        let mut response = self
            .agent
            .post(format!("{host}/wallet/{method}"))
            .send_json(params)
            .map_err(|e| JWatcherError::Rpc(e.to_string()))?;
        response
            .body_mut()
            .read_json()
            .map_err(|e| JWatcherError::RpcResponse(e.to_string()))
    }
    fn tron_solidity_call(&self, method: &str, params: Value) -> Result<Value, JWatcherError> {
        let endpoint = self
            .tron_solidity_endpoint
            .as_ref()
            .ok_or_else(|| JWatcherError::RpcResponse("TRON_NATIVE_TRANSPORT_REQUIRED".into()))?;
        if method.is_empty() || !method.bytes().all(|b| b.is_ascii_lowercase()) {
            return Err(JWatcherError::RpcResponse("TRON_NATIVE_METHOD".into()));
        }
        let base = endpoint
            .strip_suffix("getnowblock")
            .ok_or_else(|| JWatcherError::RpcResponse("TRON_SOLIDITY_ENDPOINT".into()))?;
        self.agent
            .post(format!("{base}{method}"))
            .send_json(params)
            .map_err(|error| JWatcherError::Rpc(error.to_string()))?
            .body_mut()
            .read_json()
            .map_err(|error| JWatcherError::RpcResponse(error.to_string()))
    }
    fn call(&self, method: &str, params: Value) -> Result<Value, JWatcherError> {
        if method == "eth_blockNumber"
            && let Some(endpoint) = &self.tron_solidity_endpoint
        {
            return self.solidified_head(endpoint);
        }
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
