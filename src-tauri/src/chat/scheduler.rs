//! One process-wide budget for assistant SQL, shared by chat, MCP and schema reads.
//! Permits live in the blocking worker so cancellation cannot free capacity early.
use crate::database::Database;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Condvar, Mutex, OnceLock, Weak},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Default)]
struct State {
    analysis: bool,
    writer: bool,
    waiting_writers: usize,
}
#[derive(Default)]
pub(crate) struct Workload {
    state: Mutex<State>,
    changed: Condvar,
}
pub(crate) struct WritePermit(Arc<Workload>);
struct ReadPermit(Arc<Workload>);
impl Workload {
    pub(crate) fn write(self: &Arc<Self>) -> WritePermit {
        let mut state = self.state.lock().unwrap();
        state.waiting_writers += 1;
        while state.analysis || state.writer {
            state = self.changed.wait(state).unwrap();
        }
        state.waiting_writers -= 1;
        state.writer = true;
        WritePermit(self.clone())
    }
    fn try_read(self: &Arc<Self>) -> Option<ReadPermit> {
        let mut state = self.state.lock().unwrap();
        if state.analysis || state.writer || state.waiting_writers > 0 {
            return None;
        }
        state.analysis = true;
        Some(ReadPermit(self.clone()))
    }
}
impl Drop for WritePermit {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().writer = false;
        self.0.changed.notify_all();
    }
}
impl Drop for ReadPermit {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().analysis = false;
        self.0.changed.notify_all();
    }
}

pub(crate) fn workload(root: &std::path::Path, profile: &str) -> Arc<Workload> {
    type Lanes = Mutex<HashMap<(PathBuf, String), Weak<Workload>>>;
    static LANES: OnceLock<Lanes> = OnceLock::new();
    let mut lanes = LANES.get_or_init(Default::default).lock().unwrap();
    lanes.retain(|_, lane| lane.strong_count() > 0);
    let key = (
        root.canonicalize().unwrap_or_else(|_| root.to_path_buf()),
        profile.to_owned(),
    );
    if let Some(lane) = lanes.get(&key).and_then(Weak::upgrade) {
        return lane;
    }
    let lane = Arc::new(Workload::default());
    lanes.insert(key, Arc::downgrade(&lane));
    lane
}
struct Scheduler {
    active: Arc<Semaphore>,
    queued: Arc<Semaphore>,
    wait: Duration,
}
pub(crate) struct Permit {
    _profile: ReadPermit,
    _global: OwnedSemaphorePermit,
}
impl Scheduler {
    async fn acquire(&self, lane: Arc<Workload>) -> Result<Permit, String> {
        let _queue = self
            .queued
            .clone()
            .try_acquire_owned()
            .map_err(|_| "Analysis queue is full; retry shortly")?;
        tokio::time::timeout(self.wait, async {
            let profile = loop {
                if let Some(permit) = lane.try_read() {
                    break permit;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            };
            let global = self
                .active
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| "Analysis scheduler unavailable")?;
            Ok(Permit {
                _profile: profile,
                _global: global,
            })
        })
        .await
        .map_err(|_| {
            "Analysis queue wait timed out; an import or another analysis is running. Retry shortly"
                .to_string()
        })?
    }
}
pub(crate) async fn acquire(db: &Database) -> Result<Permit, String> {
    static SCHEDULER: OnceLock<Scheduler> = OnceLock::new();
    SCHEDULER
        .get_or_init(|| Scheduler {
            active: Arc::new(Semaphore::new(4)),
            queued: Arc::new(Semaphore::new(32)),
            wait: Duration::from_secs(10),
        })
        .acquire(db.workload.clone())
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scheduler(active: usize, queued: usize) -> Scheduler {
        Scheduler {
            active: Arc::new(Semaphore::new(active)),
            queued: Arc::new(Semaphore::new(queued)),
            wait: Duration::from_millis(100),
        }
    }
    #[tokio::test]
    async fn profile_and_global_budgets_have_bounded_waits() {
        let scheduler = scheduler(1, 4);
        let lane = Arc::new(Workload::default());
        let other = Arc::new(Workload::default());
        let first = scheduler.acquire(lane.clone()).await.unwrap();
        assert!(scheduler
            .acquire(lane.clone())
            .await
            .err()
            .unwrap()
            .contains("wait timed out"));
        assert!(scheduler
            .acquire(other.clone())
            .await
            .err()
            .unwrap()
            .contains("wait timed out"));
        drop(first);
        drop(scheduler.acquire(other).await.unwrap());
        assert!(scheduler.acquire(lane).await.is_ok());
    }
    #[tokio::test]
    async fn cancelled_waiters_release_queue_and_profile_capacity() {
        let scheduler = scheduler(1, 1);
        let first = scheduler
            .acquire(Arc::new(Workload::default()))
            .await
            .unwrap();
        let lane = Arc::new(Workload::default());
        let mut pending = Box::pin(scheduler.acquire(lane.clone()));
        tokio::select! { biased; _= &mut pending=>panic!("should wait for global slot"), _=tokio::time::sleep(Duration::from_millis(5))=>{} }
        assert!(scheduler
            .acquire(Arc::new(Workload::default()))
            .await
            .err()
            .unwrap()
            .contains("queue is full"));
        drop(pending);
        assert!(!lane.state.lock().unwrap().analysis);
        assert_eq!(scheduler.queued.available_permits(), 1);
        drop(first);
        assert!(scheduler.acquire(lane).await.is_ok());
    }
    #[tokio::test]
    async fn imports_exclude_analysis_and_waiting_writers_take_priority() {
        let lane = Arc::new(Workload::default());
        let reader = lane.try_read().unwrap();
        let writer_lane = lane.clone();
        let (started, received) = std::sync::mpsc::channel();
        let (release, finished) = std::sync::mpsc::channel();
        let task = std::thread::spawn(move || {
            let _permit = writer_lane.write();
            started.send(()).unwrap();
            finished.recv_timeout(Duration::from_secs(2)).unwrap();
        });
        while lane.state.lock().unwrap().waiting_writers == 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        drop(reader);
        assert!(lane.try_read().is_none());
        received.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(lane.try_read().is_none());
        release.send(()).unwrap();
        task.join().unwrap();
        assert!(scheduler(1, 1).acquire(lane).await.is_ok());
    }
    #[test]
    fn profiles_and_installations_have_independent_lanes() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let first = workload(a.path(), "default");
        assert!(Arc::ptr_eq(&first, &workload(a.path(), "default")));
        assert!(!Arc::ptr_eq(&first, &workload(a.path(), "other")));
        assert!(!Arc::ptr_eq(&first, &workload(b.path(), "default")));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn writer_waits_leave_async_runtime_free_to_release_analysis() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::new(root.path().into(), "default").unwrap());
        let scheduler = scheduler(1, 4);
        let analysis = scheduler.acquire(db.workload.clone()).await.unwrap();
        let writer_db = db.clone();
        let writer = tokio::spawn(async move { writer_db.delete_all_flights_async().await });
        // This timer and permit release must run even with a contending writer.
        tokio::time::timeout(Duration::from_secs(2), async {
            while db.workload.state.lock().unwrap().waiting_writers == 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            drop(analysis);
            writer.await.unwrap().unwrap();
        })
        .await
        .unwrap();
        assert!(scheduler.acquire(db.workload.clone()).await.is_ok());
    }
}
