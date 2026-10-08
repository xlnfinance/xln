//! Draft socket job controller: public progress only; adoption stays on Runtime writer.
use crate::runtime_adapter::custody::custody_worker::{CustodyOwner, PrivateWorker, WorkerMessage};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::TryRecvError,
    },
};

pub struct CustodyConfig {
    pub bun: PathBuf,
    pub script: PathBuf,
    pub owner_path: PathBuf,
    pub occupied: Arc<AtomicBool>,
}
pub struct CustodyJob {
    pub request_id: String,
    pub job_id: String,
    pub expires_at_ms: Option<u64>,
    worker: PrivateWorker,
    lease: Arc<AtomicBool>,
}
pub enum CustodyPoll {
    Progress(Value),
    Adopt(CustodyOwner),
    Failed(String),
    Pending,
}
impl CustodyJob {
    pub fn start(
        config: &CustodyConfig,
        request: &Value,
        expires_at_ms: Option<u64>,
    ) -> Result<Self, String> {
        let id = request["id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .ok_or("E_BAD_QUERY:id")?;
        let job = request["jobId"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .ok_or("E_BAD_QUERY:jobId")?;
        if config
            .occupied
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("E_COMMAND_PENDING:a BrainVault derivation is already running".into());
        }
        let worker = match PrivateWorker::spawn(
            &config.bun,
            &config.script,
            &config.owner_path,
            Some(request["input"].clone()),
        ) {
            Ok(worker) => worker,
            Err(error) => {
                config.occupied.store(false, Ordering::Release);
                return Err(error);
            }
        };
        Ok(Self {
            request_id: id.into(),
            job_id: job.into(),
            expires_at_ms,
            worker,
            lease: config.occupied.clone(),
        })
    }
    pub fn poll(&mut self) -> CustodyPoll {
        match self.worker.messages.try_recv() {
            Ok(WorkerMessage::Progress(progress)) => CustodyPoll::Progress(
                json!({"v":1,"op":"brainvault-progress","jobId":self.job_id,"progress":progress}),
            ),
            Ok(WorkerMessage::Owner(owner)) => match self.worker.finish() {
                Ok(()) => CustodyPoll::Adopt(owner),
                Err(error) => CustodyPoll::Failed(error),
            },
            Ok(WorkerMessage::Failed(code)) => CustodyPoll::Failed(code),
            Ok(WorkerMessage::Absent) => {
                CustodyPoll::Failed("BRAINVAULT_PRIVATE_OWNER_MISSING".into())
            }
            Err(TryRecvError::Empty) => CustodyPoll::Pending,
            Err(TryRecvError::Disconnected) => {
                CustodyPoll::Failed("BRAINVAULT_PRIVATE_WORKER_EXITED".into())
            }
        }
    }
    pub fn cancel(&mut self) -> Result<(), String> {
        self.worker.cancel()
    }
}
impl Drop for CustodyJob {
    fn drop(&mut self) {
        match self.worker.cancel() {
            Ok(()) => self.lease.store(false, Ordering::Release),
            Err(error) => eprintln!("[ERROR][runtime.brainvault] {error}:custody_lease_retained"),
        }
    }
}

impl CustodyConfig {
    pub fn from_environment() -> Result<Option<Self>, String> {
        let Some(path) = std::env::var_os("XLN_BRAINVAULT_OWNER_PATH").filter(|v| !v.is_empty())
        else {
            return Ok(None);
        };
        let required = |name: &str| {
            std::env::var_os(name)
                .map(PathBuf::from)
                .filter(|p| p.is_absolute() && p.is_file())
                .ok_or_else(|| format!("BRAINVAULT_WORKER_CONFIG:{name}"))
        };
        Ok(Some(Self {
            bun: required("XLN_BRAINVAULT_BUN_PATH")?,
            script: required("XLN_BRAINVAULT_CUSTODY_WORKER_PATH")?,
            owner_path: PathBuf::from(path),
            occupied: Arc::new(AtomicBool::new(false)),
        }))
    }
    pub fn load(&self) -> Result<Option<CustodyOwner>, String> {
        let mut worker = PrivateWorker::spawn(&self.bun, &self.script, &self.owner_path, None)?;
        match worker
            .messages
            .recv_timeout(std::time::Duration::from_secs(30))
        {
            Ok(WorkerMessage::Owner(owner)) => {
                worker.finish()?;
                Ok(Some(owner))
            }
            Ok(WorkerMessage::Absent) => {
                worker.finish()?;
                Ok(None)
            }
            Ok(WorkerMessage::Failed(error)) => Err(error),
            _ => Err("BRAINVAULT_PRIVATE_LOAD_FAILED".into()),
        }
    }
}
