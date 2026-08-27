use std::fs;
use std::io::{BufRead as _, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

pub(super) struct CanonicalWsServer {
    child: Child,
    directory: std::path::PathBuf,
    received: std::path::PathBuf,
    pub runtime_id: String,
    pub port: u64,
}

impl CanonicalWsServer {
    pub fn start(label: &str) -> Self {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .expect("repository root");
        let directory = std::env::temp_dir().join(format!(
            "xln-rscore-processor-ws-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("server fixture directory");
        let received = directory.join("received.log");
        let script = r#"
import { appendFileSync } from 'node:fs';
import { deriveSignerAddressSync } from './core/account/crypto.ts';
import { createDirectRuntimeWsRoute } from './core/network/p2p/direct-runtime-bun.ts';
const seed='rrs-processor-server';
const runtimeId=deriveSignerAddressSync(seed,'1').toLowerCase();
const route=createDirectRuntimeWsRoute({runtimeId,runtimeSeed:seed,path:'/ws',onEntityInputs(_from,envelope){appendFileSync(process.env.RRS_RECEIVED_PATH,JSON.stringify({height:envelope.sourceRuntimeHeight,count:envelope.entityInputs.length})+'\n');}});
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request,ref){if(ref.upgrade(request))return;return new Response('websocket only',{status:400});},websocket:route.websocket});
console.log(JSON.stringify({port:server.port,runtimeId}));
process.on('SIGTERM',()=>{server.stop(true);process.exit(0)});
"#;
        let mut child = Command::new("bun")
            .args(["-e", script])
            .current_dir(root)
            .env("RRS_RECEIVED_PATH", &received)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("canonical websocket server");
        let mut line = String::new();
        BufReader::new(child.stdout.as_mut().expect("server stdout"))
            .read_line(&mut line)
            .expect("server startup");
        let startup: Value = serde_json::from_str(&line).expect("server startup json");
        Self {
            child,
            directory,
            received,
            runtime_id: startup["runtimeId"]
                .as_str()
                .expect("server runtime id")
                .to_string(),
            port: startup["port"].as_u64().expect("server port"),
        }
    }

    pub fn wait_for_rows(&self, count: usize) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if self.rows().is_some_and(|received| received.len() >= count) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("websocket delivery timeout");
    }

    pub fn rows(&self) -> Option<Vec<Value>> {
        fs::read_to_string(&self.received).ok().map(|contents| {
            contents
                .lines()
                .map(|line| serde_json::from_str(line).expect("received envelope row"))
                .collect()
        })
    }
}

impl Drop for CanonicalWsServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.directory);
    }
}
