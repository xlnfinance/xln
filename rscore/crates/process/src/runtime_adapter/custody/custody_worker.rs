//! Private child IPC. Never derive Debug or forward a custody message to public sockets.
use serde_json::{Value, json};
use std::os::unix::process::CommandExt;
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver},
};

pub struct CustodyOwner {
    pub signer_id: String,
    pub private_key: [u8; 32],
    pub entity_seed: String,
    pub public_derivation: Value,
}
pub enum WorkerMessage {
    Progress(Value),
    Owner(CustodyOwner),
    Absent,
    Failed(String),
}
pub struct PrivateWorker {
    child: Child,
    group: u32,
    terminated: bool,
    pub messages: Receiver<WorkerMessage>,
}
fn bytes32(text: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(text.strip_prefix("0x").unwrap_or(text))
        .map_err(|_| "BRAINVAULT_PRIVATE_KEY_INVALID")?;
    bytes
        .try_into()
        .map_err(|_| "BRAINVAULT_PRIVATE_KEY_INVALID".into())
}
fn decode(value: Value) -> Result<WorkerMessage, String> {
    match value["type"].as_str() {
        Some("absent") => Ok(WorkerMessage::Absent),
        Some("failed") => {
            let code = value["code"]
                .as_str()
                .filter(|s| s.len() < 128 && s.bytes().all(|c| c.is_ascii_uppercase() || c == b'_'))
                .ok_or("BRAINVAULT_PRIVATE_ERROR_INVALID")?;
            Ok(WorkerMessage::Failed(code.into()))
        }
        Some("progress") => {
            let mut output = serde_json::Map::new();
            for key in ["completed", "total", "elapsedMs", "lastShardMs", "workers"] {
                let n = value["progress"][key]
                    .as_f64()
                    .filter(|n| n.is_finite() && *n >= 0.0)
                    .ok_or("BRAINVAULT_PRIVATE_PROGRESS_INVALID")?;
                output.insert(key.into(), json!(n));
            }
            Ok(WorkerMessage::Progress(Value::Object(output)))
        }
        Some("custody-ready") => {
            let signer = value["signerId"]
                .as_str()
                .ok_or("BRAINVAULT_PRIVATE_SIGNER_INVALID")?
                .to_lowercase();
            let key = bytes32(
                value["privateKey"]
                    .as_str()
                    .ok_or("BRAINVAULT_PRIVATE_KEY_INVALID")?,
            )?;
            let address = xln_rscore_crypto::address_of_private_key(&key)
                .ok_or("BRAINVAULT_PRIVATE_KEY_INVALID")?;
            if signer != format!("0x{}", hex::encode(address)) {
                return Err("BRAINVAULT_PRIVATE_SIGNER_MISMATCH".into());
            }
            let seed = value["entitySeed"]
                .as_str()
                .filter(|s| {
                    s.len() == 130
                        && s.starts_with("0x")
                        && s[2..].bytes().all(|c| c.is_ascii_hexdigit())
                })
                .ok_or("BRAINVAULT_PRIVATE_SEED_INVALID")?
                .into();
            let mut public = serde_json::Map::new();
            for key in [
                "specId",
                "backend",
                "shardCount",
                "factor",
                "workers",
                "derivationTimeMs",
                "ethereumAddress",
            ] {
                public.insert(
                    key.into(),
                    value["publicDerivation"]
                        .get(key)
                        .ok_or("BRAINVAULT_PRIVATE_RECEIPT_INVALID")?
                        .clone(),
                );
            }
            if public["ethereumAddress"].as_str().map(str::to_lowercase) != Some(signer.clone())
                || public["backend"] != "native-node"
            {
                return Err("BRAINVAULT_PRIVATE_RECEIPT_INVALID".into());
            }
            Ok(WorkerMessage::Owner(CustodyOwner {
                signer_id: signer,
                private_key: key,
                entity_seed: seed,
                public_derivation: Value::Object(public),
            }))
        }
        _ => Err("BRAINVAULT_PRIVATE_MESSAGE_INVALID".into()),
    }
}
impl PrivateWorker {
    pub fn spawn(
        bun: &Path,
        script: &Path,
        owner_path: &Path,
        input: Option<Value>,
    ) -> Result<Self, String> {
        let command = match input {
            Some(input) => json!({"op":"derive","path":owner_path,"input":input}),
            None => json!({"op":"load","path":owner_path}),
        };
        let encoded =
            serde_json::to_vec(&command).map_err(|_| "BRAINVAULT_PRIVATE_INPUT_INVALID")?;
        if encoded.len() > 65_536 {
            return Err("BRAINVAULT_PRIVATE_INPUT_TOO_LARGE".into());
        }
        let mut child = Command::new(bun)
            .arg(script)
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "BRAINVAULT_PRIVATE_SPAWN_FAILED")?;
        let write = child
            .stdin
            .take()
            .ok_or("BRAINVAULT_PRIVATE_STDIN_MISSING")?
            .write_all(&encoded);
        if write.is_err() {
            let group = child.id();
            crate::runtime_adapter::custody::custody_group::terminate(&mut child, group)?;
            return Err("BRAINVAULT_PRIVATE_STDIN_FAILED".into());
        }
        let stdout = child
            .stdout
            .take()
            .ok_or("BRAINVAULT_PRIVATE_STDOUT_MISSING")?;
        let (tx, messages) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                // Capped private NDJSON; do not allocate from unbounded child output.
                let read = std::io::Read::take(&mut reader, 65_537).read_until(b'\n', &mut bytes);
                let value = match read {
                    Ok(0) => break,
                    Ok(n) if n <= 65_536 => serde_json::from_slice(&bytes)
                        .map_err(|_| "BRAINVAULT_PRIVATE_JSON_INVALID".into())
                        .and_then(decode),
                    _ => Err("BRAINVAULT_PRIVATE_FRAME_INVALID".into()),
                };
                let terminal = !matches!(value, Ok(WorkerMessage::Progress(_)));
                if tx
                    .send(value.unwrap_or_else(WorkerMessage::Failed))
                    .is_err()
                    || terminal
                {
                    break;
                }
            }
        });
        let group = child.id();
        Ok(Self {
            child,
            group,
            terminated: false,
            messages,
        })
    }
    pub fn cancel(&mut self) -> Result<(), String> {
        if !self.terminated {
            crate::runtime_adapter::custody::custody_group::terminate(&mut self.child, self.group)?;
            self.terminated = true;
        }
        Ok(())
    }
    pub fn finish(&mut self) -> Result<(), String> {
        if !self
            .child
            .wait()
            .map_err(|_| "BRAINVAULT_PRIVATE_WAIT_FAILED")?
            .success()
        {
            return Err("BRAINVAULT_PRIVATE_WORKER_FAILED".into());
        }
        Ok(())
    }
}
impl Drop for PrivateWorker {
    fn drop(&mut self) {
        if let Err(error) = self.cancel() {
            eprintln!("[ERROR][runtime.brainvault] {error}:group={}", self.group);
        }
    }
}
