//! Long-lived worker actors for resident Account shards.
//!
//! A worker state is moved into its thread exactly once at startup. Calls send
//! only typed operation batches; Account replicas and Patricia nodes never
//! cross back to the coordinator. This is deliberately separate from Rayon:
//! work stealing is useful for stateless jobs, but it cannot express permanent
//! ownership of a shard's mutable replica state.

use std::sync::Arc;
use std::sync::mpsc::{SyncSender, sync_channel};
use std::thread::{self, JoinHandle};

use crate::BatchError;

type ResidentJob<S> = Box<dyn FnOnce(&mut S) + Send + 'static>;

enum ResidentCommand<S> {
    Run(ResidentJob<S>),
    Stop,
}

struct ResidentWorker<S> {
    sender: SyncSender<ResidentCommand<S>>,
    join: Option<JoinHandle<()>>,
}

/// A fixed set of actor threads, each permanently owning one state value.
pub(crate) struct ResidentWorkerPool<S> {
    workers: Vec<ResidentWorker<S>>,
}

impl<S: Send + 'static> ResidentWorkerPool<S> {
    /// Move each initial state into its permanent worker thread.
    pub(crate) fn start(thread_prefix: &str, states: Vec<S>) -> Result<Self, BatchError> {
        if states.is_empty() {
            return Err(BatchError::InvalidWorkerCount(0));
        }
        let mut workers = Vec::with_capacity(states.len());
        for (worker, mut state) in states.into_iter().enumerate() {
            let (sender, receiver) = sync_channel::<ResidentCommand<S>>(1);
            let name = format!("{thread_prefix}-{worker}");
            let join = thread::Builder::new()
                .name(name)
                .spawn(move || {
                    while let Ok(command) = receiver.recv() {
                        match command {
                            ResidentCommand::Run(job) => job(&mut state),
                            ResidentCommand::Stop => return,
                        }
                    }
                })
                .map_err(|error| BatchError::ResidentWorkerStart {
                    worker,
                    detail: error.to_string(),
                })?;
            workers.push(ResidentWorker {
                sender,
                join: Some(join),
            });
        }
        Ok(Self { workers })
    }

    pub(crate) fn worker_count(&self) -> usize {
        self.workers.len()
    }

    /// Execute one batch on every non-empty lane and return results by worker.
    ///
    /// The caller constructs exactly one lane per worker. Within a lane the
    /// supplied function runs serially, which preserves Account-local order.
    /// All active lanes run concurrently and join exactly once here.
    pub(crate) fn run_lanes<T, R, F>(
        &mut self,
        lanes: Vec<Vec<T>>,
        apply: F,
    ) -> Result<Vec<Vec<R>>, BatchError>
    where
        T: Send + 'static,
        R: Send + 'static,
        F: Fn(&mut S, T) -> R + Send + Sync + 'static,
    {
        if lanes.len() != self.workers.len() {
            return Err(BatchError::ResidentLaneCount {
                actual: lanes.len(),
                expected: self.workers.len(),
            });
        }
        let apply = Arc::new(apply);
        let active = lanes.iter().filter(|lane| !lane.is_empty()).count();
        let (reply_sender, reply_receiver) = sync_channel::<(usize, Vec<R>)>(active.max(1));
        for (worker, items) in lanes.into_iter().enumerate() {
            if items.is_empty() {
                continue;
            }
            let apply = Arc::clone(&apply);
            let reply_sender = reply_sender.clone();
            let job = Box::new(move |state: &mut S| {
                let rows = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    items.into_iter().map(|item| apply(state, item)).collect()
                })) {
                    Ok(rows) => rows,
                    Err(_) => std::process::abort(),
                };
                if reply_sender.send((worker, rows)).is_err() {
                    std::process::abort();
                }
            });
            if self.workers[worker]
                .sender
                .send(ResidentCommand::Run(job))
                .is_err()
            {
                std::process::abort();
            }
        }
        drop(reply_sender);
        let mut replies = (0..self.workers.len())
            .map(|_| None)
            .collect::<Vec<Option<Vec<R>>>>();
        for _ in 0..active {
            let (worker, rows) = reply_receiver
                .recv()
                .map_err(|_| BatchError::ResidentWorkerReplyMissing)?;
            replies[worker] = Some(rows);
        }
        Ok(replies.into_iter().map(Option::unwrap_or_default).collect())
    }
}

impl<S> Drop for ResidentWorkerPool<S> {
    fn drop(&mut self) {
        for worker in &self.workers {
            let _ = worker.sender.send(ResidentCommand::Stop);
        }
        for (index, worker) in self.workers.iter_mut().enumerate() {
            let Some(join) = worker.join.take() else {
                continue;
            };
            if join.join().is_err() && !thread::panicking() {
                panic!("RSCORE_RESIDENT_WORKER_PANICKED:{index}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ResidentWorkerPool;

    #[derive(Default)]
    struct WorkerState {
        values: Vec<u64>,
    }

    #[test]
    fn state_stays_resident_and_lanes_join_in_worker_order() {
        let states = (0..4).map(|_| WorkerState::default()).collect();
        let mut pool = ResidentWorkerPool::start("resident-test", states).expect("pool");
        let first = pool
            .run_lanes(
                vec![vec![1, 2], vec![], vec![3], vec![4, 5]],
                |state, value| {
                    state.values.push(value);
                    state.values.len()
                },
            )
            .expect("first");
        assert_eq!(first, vec![vec![1, 2], vec![], vec![1], vec![1, 2]]);

        let second = pool
            .run_lanes(vec![vec![6], vec![7], vec![], vec![8]], |state, value| {
                state.values.push(value);
                state.values.clone()
            })
            .expect("second");
        assert_eq!(second[0], vec![vec![1, 2, 6]]);
        assert_eq!(second[1], vec![vec![7]]);
        assert!(second[2].is_empty());
        assert_eq!(second[3], vec![vec![4, 5, 8]]);
        assert_eq!(pool.worker_count(), 4);
    }
}
