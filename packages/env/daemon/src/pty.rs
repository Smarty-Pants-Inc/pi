//! `pty`: a program in a pseudo-terminal, for interactive terminals. Unlike `exec`, output is the terminal's raw
//! bytes, and the program reads input: `ptyWrite`, `ptyResize` and `ptyForeground` address the running `pty` request by
//! its id.

use crate::errors::Failure;
use crate::exec::{Control, Groups};
#[cfg(unix)]
use crate::exec::{Message, kill_group};
#[cfg(unix)]
use crate::frame::{EVENT, Frame};
use crate::output::Output;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
#[cfg(unix)]
use std::sync::{Condvar, OnceLock};

/// After the program exits, output still arriving is collected until this much silence.
#[cfg(unix)]
const EXIT_GRACE: std::time::Duration = std::time::Duration::from_millis(100);
#[cfg(unix)]
const CLEANUP_RETRY_INITIAL: std::time::Duration = std::time::Duration::from_millis(100);
#[cfg(unix)]
const CLEANUP_RETRY_MAX: std::time::Duration = std::time::Duration::from_secs(5);
#[cfg(unix)]
const CLEANUP_TOTAL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10 * 60);
/// Largest terminal size accepted, in cells.
const MAX_CELLS: u64 = 4096;
/// Queued input, including the write in progress, per terminal.
const INPUT_LIMIT: usize = 1024 * 1024;

struct Input {
    bytes: Vec<u8>,
    queued: Arc<AtomicUsize>,
}

impl Drop for Input {
    fn drop(&mut self) {
        self.queued.fetch_sub(self.bytes.len(), Ordering::SeqCst);
    }
}

/// What `ptyWrite`, `ptyResize` and `ptyForeground` reach: the terminal of one running `pty` request.
pub struct Terminal {
    input: Sender<Input>,
    queued: Arc<AtomicUsize>,
    #[cfg(unix)]
    master: Arc<std::fs::File>,
    /// The program's process id, which is also its process group's (it leads the terminal's session).
    #[cfg(unix)]
    pid: u32,
}

/// Running terminals by the id of their `pty` request.
pub type Terminals = Arc<Mutex<HashMap<u32, Arc<Terminal>>>>;

#[cfg_attr(not(unix), allow(dead_code))]
pub struct PtyRequest {
    argv: Option<Vec<String>>,
    cwd: String,
    env: Map<String, Value>,
    inherit_env: bool,
    cols: u16,
    rows: u16,
}

fn size(json: &Value, key: &str) -> Result<u16, Failure> {
    match json[key].as_u64() {
        Some(value) if (1..=MAX_CELLS).contains(&value) => Ok(value as u16),
        _ => Err(Failure::new(
            "EINVAL",
            format!("{key} must be between 1 and {MAX_CELLS}"),
        )),
    }
}

impl PtyRequest {
    pub fn from_json(json: &Value) -> Result<PtyRequest, Failure> {
        let argv = match &json["argv"] {
            Value::Null => None,
            value => Some(
                value
                    .as_array()
                    .and_then(|items| {
                        items
                            .iter()
                            .map(|item| item.as_str().map(str::to_string))
                            .collect()
                    })
                    .filter(|argv: &Vec<String>| !argv.is_empty())
                    .ok_or_else(|| {
                        Failure::new("EINVAL", "argv must be a non-empty array of strings")
                    })?,
            ),
        };
        Ok(PtyRequest {
            argv,
            cwd: json["cwd"]
                .as_str()
                .ok_or_else(|| Failure::new("EINVAL", "pty needs cwd"))?
                .to_string(),
            env: json["env"].as_object().cloned().unwrap_or_default(),
            inherit_env: json["inheritEnv"].as_bool().unwrap_or(true),
            cols: size(json, "cols")?,
            rows: size(json, "rows")?,
        })
    }
}

fn find(terminals: &Terminals, json: &Value) -> Result<Arc<Terminal>, Failure> {
    let target = json["target"]
        .as_u64()
        .ok_or_else(|| Failure::new("EINVAL", "missing field target"))?;
    terminals
        .lock()
        .unwrap()
        .get(&(target as u32))
        .cloned()
        .ok_or_else(|| Failure::new("EBADF", "no running terminal with this id"))
}

/// Queue input for the terminal; it is written in the order it arrives, without holding up other requests.
pub fn write(terminals: &Terminals, json: &Value, payload: Vec<u8>) -> Result<Value, Failure> {
    let terminal = find(terminals, json)?;
    // Empty writes need no queue entry; a byte budget must also bound the number of queued entries.
    if payload.is_empty() {
        return Ok(json!({}));
    }
    terminal
        .queued
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |queued| {
            queued
                .checked_add(payload.len())
                .filter(|total| *total <= INPUT_LIMIT)
        })
        .map_err(|_| {
            Failure::new(
                "EAGAIN",
                "terminal input queue is full (1 MiB limit); retry after it drains",
            )
        })?;
    terminal
        .input
        .send(Input {
            bytes: payload,
            queued: terminal.queued.clone(),
        })
        .map_err(|_| Failure::new("EBADF", "the terminal has ended"))?;
    Ok(json!({}))
}

/// Change the terminal's size; the program receives `SIGWINCH`.
pub fn resize(terminals: &Terminals, json: &Value) -> Result<Value, Failure> {
    let terminal = find(terminals, json)?;
    let (cols, rows) = (size(json, "cols")?, size(json, "rows")?);
    #[cfg(unix)]
    unix::set_size(&terminal.master, cols, rows)
        .map_err(|error| Failure::io(&error, "ioctl", "pty"))?;
    #[cfg(not(unix))]
    let _ = (terminal, cols, rows);
    Ok(json!({}))
}

/// The process group in the terminal's foreground when it is not the program's own: a job a shell started, such as an
/// editor. `{ foreground: null }` while the program itself is in front (a shell at its prompt).
pub fn foreground(terminals: &Terminals, json: &Value) -> Result<Value, Failure> {
    let terminal = find(terminals, json)?;
    #[cfg(unix)]
    {
        let group = unix::foreground(&terminal.master)
            .map_err(|error| Failure::io(&error, "tcgetpgrp", "pty"))?;
        if group <= 0 || group as u32 == terminal.pid {
            return Ok(json!({ "foreground": null }));
        }
        let name = unix::process_name(group);
        Ok(json!({ "foreground": { "pid": group, "name": name } }))
    }
    #[cfg(not(unix))]
    {
        let _ = terminal;
        Ok(json!({ "foreground": null }))
    }
}

#[cfg(not(unix))]
pub fn run(
    _id: u32,
    _request: PtyRequest,
    _output: &Arc<Output>,
    _control: &Control,
    _groups: &Groups,
    _terminals: &Terminals,
) -> Result<Value, Failure> {
    Err(Failure::new(
        "ENOTSUP",
        "Terminals are not supported on this system yet",
    ))
}

/// Run the program in a new terminal, sending a `started` event and then its output, until it exits.
#[cfg(unix)]
pub fn run(
    id: u32,
    request: PtyRequest,
    output: &Arc<Output>,
    control: &Control,
    groups: &Groups,
    terminals: &Terminals,
) -> Result<Value, Failure> {
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc::{self, RecvTimeoutError};
    use std::thread;
    use std::time::{Duration, Instant};

    let (sender, receiver) = mpsc::channel();
    control.attach(sender.clone());
    if control.aborted.load(Ordering::SeqCst) {
        return Err(Failure::new("aborted", "aborted"));
    }
    if !std::path::Path::new(&request.cwd).exists() {
        return Err(Failure::new(
            "spawn_error",
            format!("Working directory does not exist: {}", request.cwd),
        ));
    }
    let (master, mut child) =
        unix::spawn(&request).map_err(|error| Failure::new("spawn_error", error.to_string()))?;
    let master = Arc::new(master);
    let pid = child.id();
    groups.lock().unwrap().insert(pid);
    let (input, inputs) = mpsc::channel::<Input>();
    terminals.lock().unwrap().insert(
        id,
        Arc::new(Terminal {
            input,
            queued: Arc::new(AtomicUsize::new(0)),
            master: master.clone(),
            pid,
        }),
    );
    output.control(Frame::new(
        EVENT,
        id,
        json!({ "kind": "started", "pid": pid }),
    ));

    let stop = Arc::new(AtomicBool::new(false));
    let reader = {
        let master = master.clone();
        let sender = sender.clone();
        let stop = stop.clone();
        let output = output.clone();
        thread::spawn(move || {
            unix::read(&master, &stop, |bytes| {
                let delivered = sender.send(Message::Data(0, bytes.to_vec())).is_ok();
                // Like a full pipe: a program that writes faster than the link waits.
                output.wait_for_room(&stop);
                delivered
            });
            let _ = sender.send(Message::Eof(0));
        })
    };
    let writer = {
        let master = master.clone();
        let stop = stop.clone();
        thread::spawn(move || {
            for input in inputs {
                if !unix::write_all(&master, &input.bytes, &stop) {
                    return;
                }
                // Dropping this input releases its byte charge; dropping the receiver releases any remaining queue.
            }
        })
    };
    let waiter = sender.clone();
    thread::spawn(move || {
        let _ = waiter.send(match child.wait() {
            Ok(status) => Message::Exit(status),
            Err(error) => Message::WaitFailed(error.to_string()),
        });
    });
    drop(sender);

    let mut status = None;
    let mut ended = false;
    let mut idle_until: Option<Instant> = None;
    let mut aborted = false;
    let mut killed = false;
    let kill = |killed: &mut bool| {
        if !*killed {
            *killed = true;
            kill_group(pid);
        }
    };
    if control.killed.load(Ordering::SeqCst) {
        kill(&mut killed);
    }
    loop {
        if status.is_some() && ended {
            break;
        }
        let wait = match idle_until {
            Some(idle) => {
                let now = Instant::now();
                if now >= idle {
                    // A background job may keep the terminal open after the program exited.
                    break;
                }
                idle - now
            }
            None => Duration::from_secs(3600),
        };
        match receiver.recv_timeout(wait) {
            Ok(Message::Data(_, bytes)) => {
                output.bulk(
                    Frame::with_payload(EVENT, id, json!({ "kind": "output" }), bytes),
                    None,
                );
                if status.is_some() {
                    idle_until = Some(Instant::now() + EXIT_GRACE);
                }
            }
            Ok(Message::Eof(_)) => ended = true,
            Ok(Message::Exit(exit)) => {
                status = Some(Ok(exit));
                idle_until = Some(Instant::now() + EXIT_GRACE);
            }
            Ok(Message::WaitFailed(error)) => {
                status = Some(Err(error));
                idle_until = Some(Instant::now());
            }
            Ok(Message::Cancel) => {
                aborted = true;
                kill(&mut killed);
            }
            Ok(Message::Kill) => kill(&mut killed),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    // The leader's exit is not the end of its background jobs. Keep ownership until the remaining group is stopped.
    let cleanup = cleanup_group(pid, groups, move || unix::terminate_group(pid));
    stop.store(true, Ordering::SeqCst);
    // Ending the input channel ends the writer thread.
    terminals.lock().unwrap().remove(&id);
    let _ = reader.join();
    let _ = writer.join();
    if let Some(cleanup) = cleanup {
        cleanup.recv().unwrap_or_else(|_| {
            Err(Failure::new("cleanup_failed", "PTY cleanup reaper stopped"))
        })?;
    }
    if aborted {
        return Err(Failure::new("aborted", "aborted"));
    }
    match status {
        Some(Ok(status)) => Ok(json!({ "exitCode": crate::sys::exit_code(status) })),
        Some(Err(error)) => Err(Failure::new("spawn_error", error)),
        None => Err(Failure::new(
            "spawn_error",
            "process did not report its exit",
        )),
    }
}

#[cfg(unix)]
struct PendingCleanup {
    pid: u32,
    groups: Groups,
    terminate: Box<dyn FnMut() -> std::io::Result<bool> + Send>,
    next_attempt: std::time::Instant,
    backoff: std::time::Duration,
    deadline: std::time::Instant,
    result: Sender<Result<(), Failure>>,
}

#[cfg(unix)]
struct CleanupReaperState {
    pending: HashMap<u32, PendingCleanup>,
    running: bool,
}

#[cfg(unix)]
struct CleanupReaperInner {
    state: Mutex<CleanupReaperState>,
    wake: Condvar,
    workers_started: AtomicUsize,
}

#[cfg(unix)]
#[derive(Clone)]
struct CleanupReaper {
    inner: Arc<CleanupReaperInner>,
}

#[cfg(unix)]
impl CleanupReaper {
    fn new() -> Self {
        Self {
            inner: Arc::new(CleanupReaperInner {
                state: Mutex::new(CleanupReaperState {
                    pending: HashMap::new(),
                    running: false,
                }),
                wake: Condvar::new(),
                workers_started: AtomicUsize::new(0),
            }),
        }
    }

    #[cfg(test)]
    fn workers_started(&self) -> usize {
        self.inner.workers_started.load(Ordering::SeqCst)
    }

    fn schedule(&self, pending: PendingCleanup) {
        let mut state = self.inner.state.lock().unwrap();
        state.pending.insert(pending.pid, pending);
        if !state.running {
            state.running = true;
            let inner = self.inner.clone();
            if let Err(error) = std::thread::Builder::new()
                .name("pty-cleanup-reaper".to_string())
                .spawn(move || run_cleanup_reaper(inner))
            {
                state.running = false;
                for (_, pending) in state.pending.drain() {
                    pending.groups.lock().unwrap().remove(&pending.pid);
                    eprintln!(
                        "pty: ERROR failed to start cleanup reaper for process group {}: {error}",
                        pending.pid
                    );
                    let _ = pending.result.send(Err(Failure::new(
                        "cleanup_failed",
                        format!("Failed to start PTY cleanup reaper: {error}"),
                    )));
                }
            }
        }
        self.inner.wake.notify_one();
    }
}

#[cfg(unix)]
fn cleanup_retry_backoff(backoff: std::time::Duration) -> std::time::Duration {
    backoff.saturating_add(backoff).min(CLEANUP_RETRY_MAX)
}

#[cfg(unix)]
fn run_cleanup_reaper(inner: Arc<CleanupReaperInner>) {
    inner.workers_started.fetch_add(1, Ordering::SeqCst);
    loop {
        let mut pending = {
            let mut state = inner.state.lock().unwrap();
            loop {
                if state.pending.is_empty() {
                    state.running = false;
                    return;
                }
                let (pid, next_attempt) = state
                    .pending
                    .iter()
                    .min_by_key(|(_, pending)| pending.next_attempt)
                    .map(|(pid, pending)| (*pid, pending.next_attempt))
                    .unwrap();
                let wait = next_attempt.saturating_duration_since(std::time::Instant::now());
                if wait.is_zero() {
                    break state.pending.remove(&pid).unwrap();
                }
                let (updated, _) = inner.wake.wait_timeout(state, wait).unwrap();
                state = updated;
            }
        };

        let expired = std::time::Instant::now() >= pending.deadline;
        if !expired && matches!((pending.terminate)(), Ok(true)) {
            pending.groups.lock().unwrap().remove(&pending.pid);
            let _ = pending.result.send(Ok(()));
            continue;
        }
        let now = std::time::Instant::now();
        if expired || now >= pending.deadline {
            pending.groups.lock().unwrap().remove(&pending.pid);
            eprintln!(
                "pty: ERROR process group {} cleanup deadline exceeded; dropping supervision",
                pending.pid
            );
            let _ = pending.result.send(Err(Failure::new(
                "cleanup_failed",
                format!(
                    "PTY process group {} cleanup deadline exceeded",
                    pending.pid
                ),
            )));
            continue;
        }
        pending.next_attempt = (now + pending.backoff).min(pending.deadline);
        pending.backoff = cleanup_retry_backoff(pending.backoff);
        let mut state = inner.state.lock().unwrap();
        state.pending.insert(pending.pid, pending);
        inner.wake.notify_one();
    }
}

#[cfg(unix)]
static CLEANUP_REAPER: OnceLock<CleanupReaper> = OnceLock::new();

#[cfg(unix)]
fn cleanup_group(
    pid: u32,
    groups: &Groups,
    terminate: impl FnMut() -> std::io::Result<bool> + Send + 'static,
) -> Option<std::sync::mpsc::Receiver<Result<(), Failure>>> {
    let reaper = CLEANUP_REAPER.get_or_init(CleanupReaper::new);
    cleanup_group_with_reaper(reaper, pid, groups, CLEANUP_TOTAL_DEADLINE, terminate)
}

#[cfg(unix)]
fn cleanup_group_with_reaper(
    reaper: &CleanupReaper,
    pid: u32,
    groups: &Groups,
    total_deadline: std::time::Duration,
    mut terminate: impl FnMut() -> std::io::Result<bool> + Send + 'static,
) -> Option<std::sync::mpsc::Receiver<Result<(), Failure>>> {
    match terminate() {
        Ok(true) => {
            groups.lock().unwrap().remove(&pid);
            None
        }
        outcome => {
            eprintln!(
                "pty: process group {pid} cleanup incomplete ({outcome:?}); retaining supervision"
            );
            let now = std::time::Instant::now();
            let (result, receiver) = std::sync::mpsc::channel();
            reaper.schedule(PendingCleanup {
                pid,
                groups: groups.clone(),
                terminate: Box::new(terminate),
                next_attempt: now + CLEANUP_RETRY_INITIAL,
                backoff: CLEANUP_RETRY_INITIAL.saturating_add(CLEANUP_RETRY_INITIAL),
                deadline: now + total_deadline,
                result,
            });
            Some(receiver)
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    // pi#244 / SECURITY delta round 1: a signal error or timeout must retain ownership until a later confirmed reap.
    #[test]
    fn cleanup_retains_ownership_after_signal_error_or_timeout() {
        for outcome in [
            Err(std::io::Error::from_raw_os_error(libc::EPERM)),
            Ok(false),
        ] {
            let groups: Groups = Arc::new(Mutex::new(Default::default()));
            let pid = 123;
            groups.lock().unwrap().insert(pid);
            let (resume, paused) = std::sync::mpsc::channel();
            let mut first = Some(outcome);
            cleanup_group(pid, &groups, move || {
                if let Some(outcome) = first.take() {
                    return outcome;
                }
                paused.recv().unwrap();
                Ok(true)
            });
            assert!(
                groups.lock().unwrap().contains(&pid),
                "unreaped group lost ownership"
            );
            resume.send(()).unwrap();
            wait_for_group_removed(&groups, pid);
            assert!(groups.lock().unwrap().is_empty());
        }
    }

    fn wait_for_group_removed(groups: &Groups, pid: u32) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while groups.lock().unwrap().contains(&pid) {
            assert!(
                std::time::Instant::now() < deadline,
                "group {pid} was not removed"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    // pi#244: cleanup failures share one bounded reaper instead of one retry thread per terminal.
    #[test]
    fn cleanup_failures_share_one_reaper() {
        let reaper = CleanupReaper::new();
        let groups: Groups = Arc::new(Mutex::new(Default::default()));
        let completed = Arc::new(AtomicUsize::new(0));
        for pid in 100..103 {
            groups.lock().unwrap().insert(pid);
            let completed = completed.clone();
            let mut first = true;
            cleanup_group_with_reaper(
                &reaper,
                pid,
                &groups,
                std::time::Duration::from_secs(2),
                move || {
                    if first {
                        first = false;
                        Err(std::io::Error::from_raw_os_error(libc::EPERM))
                    } else {
                        completed.fetch_add(1, Ordering::SeqCst);
                        Ok(true)
                    }
                },
            );
        }
        for pid in 100..103 {
            wait_for_group_removed(&groups, pid);
        }
        assert_eq!(completed.load(Ordering::SeqCst), 3);
        assert_eq!(reaper.workers_started(), 1);
    }

    // pi#244: retry intervals must grow exponentially and stop growing at the cap.
    #[test]
    fn cleanup_retry_cadence_backs_off() {
        let reaper = CleanupReaper::new();
        let groups: Groups = Arc::new(Mutex::new(Default::default()));
        let pid = 104;
        groups.lock().unwrap().insert(pid);
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let recorded = attempts.clone();
        let mut failures = 3;
        cleanup_group_with_reaper(
            &reaper,
            pid,
            &groups,
            std::time::Duration::from_secs(3),
            move || {
                recorded.lock().unwrap().push(std::time::Instant::now());
                if failures > 0 {
                    failures -= 1;
                    Ok(false)
                } else {
                    Ok(true)
                }
            },
        );
        wait_for_group_removed(&groups, pid);
        let attempts = attempts.lock().unwrap();
        assert!(attempts.len() >= 4);
        assert!(attempts[1].duration_since(attempts[0]) >= std::time::Duration::from_millis(70));
        assert!(attempts[2].duration_since(attempts[1]) >= std::time::Duration::from_millis(140));
        assert!(attempts[3].duration_since(attempts[2]) >= std::time::Duration::from_millis(280));
        let mut backoff = CLEANUP_RETRY_INITIAL;
        for expected in [200, 400, 800, 1600, 3200, 5000, 5000] {
            backoff = cleanup_retry_backoff(backoff);
            assert_eq!(backoff, std::time::Duration::from_millis(expected));
        }
    }

    // pi#244: a group that cannot be cleaned by the deadline is dropped rather than retried forever.
    #[test]
    fn cleanup_deadline_drops_record() {
        let reaper = CleanupReaper::new();
        let groups: Groups = Arc::new(Mutex::new(Default::default()));
        let pid = 105;
        groups.lock().unwrap().insert(pid);
        let result = cleanup_group_with_reaper(
            &reaper,
            pid,
            &groups,
            std::time::Duration::from_millis(150),
            || Ok(false),
        )
        .unwrap();
        let error = result
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, "cleanup_failed");
        assert!(error.message.contains(&pid.to_string()));
        assert!(!groups.lock().unwrap().contains(&pid));
    }

    // pi#244: a group that succeeds on a retry is removed from supervision immediately.
    #[test]
    fn cleanup_success_on_retry_removes_record() {
        let reaper = CleanupReaper::new();
        let groups: Groups = Arc::new(Mutex::new(Default::default()));
        let pid = 106;
        groups.lock().unwrap().insert(pid);
        let mut first = true;
        let result = cleanup_group_with_reaper(
            &reaper,
            pid,
            &groups,
            std::time::Duration::from_secs(2),
            move || {
                if first {
                    first = false;
                    Ok(false)
                } else {
                    Ok(true)
                }
            },
        )
        .unwrap();
        result
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap()
            .unwrap();
        assert!(!groups.lock().unwrap().contains(&pid));
    }

    // pi#244: every charged input must release its memory budget, including a disconnected receiver's queue.
    #[test]
    fn input_budget_releases_charge_on_drain_and_disconnect() {
        let terminals = Arc::new(Mutex::new(HashMap::new()));
        let queued = Arc::new(AtomicUsize::new(0));
        let (input, inputs) = std::sync::mpsc::channel();
        terminals.lock().unwrap().insert(
            3,
            Arc::new(Terminal {
                input,
                queued: queued.clone(),
                master: Arc::new(std::fs::File::open("/dev/null").unwrap()),
                pid: 0,
            }),
        );
        let target = json!({ "target": 3 });
        write(&terminals, &target, vec![0; INPUT_LIMIT]).unwrap();
        assert_eq!(queued.load(Ordering::SeqCst), INPUT_LIMIT);
        drop(inputs.recv().unwrap());
        assert_eq!(queued.load(Ordering::SeqCst), 0);
        write(&terminals, &target, vec![0; INPUT_LIMIT]).unwrap();
        drop(inputs);
        assert_eq!(queued.load(Ordering::SeqCst), 0);
        assert_eq!(
            write(&terminals, &target, vec![1]).unwrap_err().code,
            "EBADF"
        );
        assert_eq!(queued.load(Ordering::SeqCst), 0);
        write(&terminals, &target, Vec::new()).unwrap();
        assert_eq!(queued.load(Ordering::SeqCst), 0);
    }

    // pi#244: a child that never reads must not admit an unbounded queue of ptyWrite payloads.
    #[test]
    fn input_budget_rejects_writes_to_a_nonreading_child() {
        use std::os::unix::net::UnixStream;
        use std::thread;
        use std::time::Duration;

        let output = Arc::new(Output::default());
        let control = Arc::new(Control::default());
        let groups = Arc::new(Mutex::new(Default::default()));
        let terminals = Arc::new(Mutex::new(HashMap::new()));
        let (mut events, mut sink) = UnixStream::pair().unwrap();
        events
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let writer = {
            let output = output.clone();
            thread::spawn(move || output.run(&mut sink))
        };
        let worker = {
            let output = output.clone();
            let control = control.clone();
            let groups = groups.clone();
            let terminals = terminals.clone();
            thread::spawn(move || {
                let request = PtyRequest::from_json(&json!({
                    "argv": ["/bin/sh", "-c", "stty raw -echo; echo ready; exec sleep 30"],
                    "cwd": crate::sys::tmpdir(), "cols": 80, "rows": 24,
                }))
                .unwrap();
                run(2, request, &output, &control, &groups, &terminals)
            })
        };
        let mut text = Vec::new();
        let ready = loop {
            match crate::frame::read_frame(&mut events) {
                Ok(Some(frame)) => {
                    text.extend(frame.payload);
                    if String::from_utf8_lossy(&text).contains("ready") {
                        break true;
                    }
                }
                _ => break false,
            }
        };
        let queued = terminals.lock().unwrap().get(&2).unwrap().queued.clone();
        let first = write(&terminals, &json!({ "target": 2 }), vec![b'a'; INPUT_LIMIT]);
        let second = write(&terminals, &json!({ "target": 2 }), vec![b'b']);
        let oversized = write(
            &terminals,
            &json!({ "target": 2 }),
            vec![b'c'; INPUT_LIMIT + 1],
        );
        let within_budget = queued.load(Ordering::SeqCst) == INPUT_LIMIT
            && (0..32).all(|_| {
                write(&terminals, &json!({ "target": 2 }), vec![b'd'; 64 * 1024])
                    .is_err_and(|error| error.code == "EAGAIN")
            });
        // Always clean up the test's child before asserting, including the fail-before run.
        control.cancel(true);
        let result = worker.join().unwrap();
        output.close();
        writer.join().unwrap();
        assert!(ready, "PTY did not signal that raw input mode was ready");
        assert!(first.is_ok());
        assert_eq!(second.unwrap_err().code, "EAGAIN");
        assert_eq!(oversized.unwrap_err().code, "EAGAIN");
        assert!(
            within_budget,
            "queued bytes exceeded the per-terminal limit"
        );
        assert_eq!(queued.load(Ordering::SeqCst), 0);
        assert_eq!(result.unwrap()["exitCode"], 137);
    }

    // pi#244: an exited leader must not leave an unsupervised background job behind.
    #[test]
    fn shutdown_terminates_background_job() {
        let output = Arc::new(Output::default());
        let groups = Arc::new(Mutex::new(Default::default()));
        let terminals = Arc::new(Mutex::new(HashMap::new()));
        let request = PtyRequest::from_json(&json!({
            "argv": ["/bin/sh", "-c", "trap '' HUP TERM; sleep 30 & echo $!; exit 0"],
            "cwd": crate::sys::tmpdir(), "cols": 80, "rows": 24,
        }))
        .unwrap();
        let result = run(
            1,
            request,
            &output,
            &Control::default(),
            &groups,
            &terminals,
        );
        output.close();
        let mut bytes = Vec::new();
        output.run(&mut bytes);
        let mut frames = bytes.as_slice();
        let mut text = Vec::new();
        while let Some(frame) = crate::frame::read_frame(&mut frames).unwrap() {
            text.extend(frame.payload);
        }
        let pid: i32 = String::from_utf8(text).unwrap().trim().parse().unwrap();
        // Linux may briefly expose an orphan zombie until init reaps it; a zombie is not a live descendant.
        let live = if cfg!(target_os = "linux") {
            std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .is_some_and(|stat| !stat.split_once(") ").unwrap().1.starts_with('Z'))
        } else {
            // SAFETY: a signal-zero probe does not change the process.
            unsafe { libc::kill(pid, 0) == 0 }
        };
        if live {
            // SAFETY: this test owns the background job; do not leak it on the unfixed implementation.
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        assert_eq!(result.unwrap()["exitCode"], 0);
        assert!(!live, "background sleep {pid} survived the PTY request");
        assert!(terminals.lock().unwrap().is_empty());
        assert!(groups.lock().unwrap().is_empty());
    }
}

#[cfg(unix)]
mod unix {
    use super::PtyRequest;
    use std::fs::File;
    use std::io::{self, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::Value;

    fn check(result: libc::c_int) -> io::Result<libc::c_int> {
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(result)
        }
    }

    fn winsize(cols: u16, rows: u16) -> libc::winsize {
        libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        }
    }

    pub fn set_size(master: &File, cols: u16, rows: u16) -> io::Result<()> {
        let size = winsize(cols, rows);
        // SAFETY: TIOCSWINSZ reads one winsize from a valid pointer.
        check(unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ as _, &size) })?;
        Ok(())
    }

    /// The terminal's foreground process group.
    pub fn foreground(master: &File) -> io::Result<libc::pid_t> {
        // SAFETY: tcgetpgrp on a descriptor the terminal owns.
        let group = unsafe { libc::tcgetpgrp(master.as_raw_fd()) };
        if group < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(group)
        }
    }

    /// A process's name, if it still runs and the system tells.
    #[cfg(target_vendor = "apple")]
    pub fn process_name(pid: libc::pid_t) -> Option<String> {
        let mut buffer = [0u8; 256];
        // SAFETY: proc_name writes at most `buffer.len()` bytes and returns how many.
        let length =
            unsafe { libc::proc_name(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        (length > 0).then(|| String::from_utf8_lossy(&buffer[..length as usize]).into_owned())
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    pub fn process_name(pid: libc::pid_t) -> Option<String> {
        let name = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
        Some(name.trim_end().to_string()).filter(|name| !name.is_empty())
    }

    #[cfg(not(any(target_vendor = "apple", target_os = "linux", target_os = "android")))]
    pub fn process_name(_pid: libc::pid_t) -> Option<String> {
        None
    }

    fn cloexec(fd: libc::c_int) -> io::Result<()> {
        // SAFETY: fcntl on a descriptor this function's caller owns.
        unsafe {
            let flags = check(libc::fcntl(fd, libc::F_GETFD))?;
            check(libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC))?;
        }
        Ok(())
    }

    /// The program to run: `argv`, or the user's shell as a login shell (`-` before its name, as `login` does).
    fn command(request: &PtyRequest) -> Command {
        match &request.argv {
            Some(argv) => {
                let mut command = Command::new(&argv[0]);
                command.args(&argv[1..]);
                command
            }
            None => {
                let shell = request
                    .env
                    .get("SHELL")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| std::env::var("SHELL").ok())
                    .filter(|shell| !shell.is_empty() && crate::sys::path_exists(shell))
                    .unwrap_or_else(|| "/bin/sh".into());
                let name = shell.rsplit('/').next().unwrap_or("sh").to_string();
                let mut command = Command::new(&shell);
                command.arg0(format!("-{name}"));
                command
            }
        }
    }

    pub fn spawn(request: &PtyRequest) -> io::Result<(File, Child)> {
        let mut master: libc::c_int = -1;
        let mut slave: libc::c_int = -1;
        let mut size = winsize(request.cols, request.rows);
        // SAFETY: openpty writes two descriptors; the name and termios are not requested.
        check(unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &raw mut size,
            )
        })?;
        // SAFETY: openpty returned two new descriptors this function now owns.
        let (master, slave) =
            unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
        cloexec(master.as_raw_fd())?;
        cloexec(slave.as_raw_fd())?;
        let slave = File::from(slave);
        let mut command = command(request);
        command
            .current_dir(&request.cwd)
            .stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
            .stderr(Stdio::from(slave.try_clone()?));
        if !request.inherit_env {
            command.env_clear();
        }
        for (key, value) in &request.env {
            if let Some(value) = value.as_str() {
                command.env(key, value);
            }
        }
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            command.pre_exec(|| {
                // A new session whose controlling terminal is the pty (stdin), so job control and SIGHUP work; default
                // signal handling and an empty mask, as for `exec`.
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                for signal in 1..32 {
                    if signal != libc::SIGKILL && signal != libc::SIGSTOP {
                        libc::signal(signal, libc::SIG_DFL);
                    }
                }
                let mut mask: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut mask);
                libc::sigprocmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut());
                Ok(())
            });
        }
        let child = command.spawn()?;
        // Only the program holds the terminal now, so reads end once it and its descendants close it.
        drop(slave);
        let master = File::from(master);
        // SAFETY: fcntl on the descriptor owned above; reads and writes poll instead of blocking.
        unsafe {
            let flags = check(libc::fcntl(master.as_raw_fd(), libc::F_GETFL))?;
            check(libc::fcntl(
                master.as_raw_fd(),
                libc::F_SETFL,
                flags | libc::O_NONBLOCK,
            ))?;
        }
        Ok((master, child))
    }

    /// Stop remaining jobs before dropping the terminal's process-group record. The leader has already been waited
    /// for; reap any other children in the group (orphans not adopted by this process are reaped by init).
    pub fn terminate_group(pid: u32) -> io::Result<bool> {
        use std::thread;
        use std::time::{Duration, Instant};

        let group = -(pid as libc::pid_t);
        for signal in [libc::SIGTERM, libc::SIGKILL] {
            // SAFETY: signal only the process group this terminal owns.
            if unsafe { libc::kill(group, signal) } != 0 {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(libc::ESRCH) {
                    Ok(true)
                } else {
                    Err(error)
                };
            }
            let deadline = Instant::now() + Duration::from_millis(250);
            loop {
                loop {
                    // SAFETY: non-blocking waits for this group's children only; no other request's child is reaped.
                    let reaped =
                        unsafe { libc::waitpid(group, std::ptr::null_mut(), libc::WNOHANG) };
                    if reaped > 0 {
                        continue;
                    }
                    if reaped == 0 {
                        break;
                    }
                    let error = io::Error::last_os_error();
                    match error.raw_os_error() {
                        Some(libc::ECHILD) => break,
                        Some(libc::EINTR) => continue,
                        _ => return Err(error),
                    }
                }
                // SAFETY: signal zero only probes whether the owned group still exists. Only ESRCH proves emptiness.
                if unsafe { libc::kill(group, 0) } != 0 {
                    let error = io::Error::last_os_error();
                    return if error.raw_os_error() == Some(libc::ESRCH) {
                        Ok(true)
                    } else {
                        Err(error)
                    };
                }
                if Instant::now() >= deadline {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
        Ok(false)
    }

    fn poll(fd: libc::c_int, events: libc::c_short) -> io::Result<bool> {
        let mut poll = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        // SAFETY: one valid pollfd.
        let ready = unsafe { libc::poll(&mut poll, 1, 100) };
        if ready < 0 {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::Interrupted {
                Ok(false)
            } else {
                Err(error)
            };
        }
        Ok(ready > 0)
    }

    /// Read until the terminal closes (Linux reports `EIO` once no program holds it), `on_data` returns false, or
    /// `stop` is set.
    pub fn read(master: &File, stop: &AtomicBool, mut on_data: impl FnMut(&[u8]) -> bool) {
        let mut buffer = vec![0u8; 64 * 1024];
        while !stop.load(Ordering::SeqCst) {
            match poll(master.as_raw_fd(), libc::POLLIN) {
                Ok(false) => continue,
                Ok(true) => {}
                Err(_) => return,
            }
            match (&*master).read(&mut buffer) {
                Ok(0) => return,
                Ok(read) => {
                    if !on_data(&buffer[..read]) {
                        return;
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) => {}
                Err(_) => return,
            }
        }
    }

    /// Write all of `bytes`, waiting while the program does not read its input; false once the terminal is gone.
    pub fn write_all(master: &File, mut bytes: &[u8], stop: &AtomicBool) -> bool {
        while !bytes.is_empty() {
            if stop.load(Ordering::SeqCst) {
                return false;
            }
            match (&*master).write(bytes) {
                Ok(0) => return false,
                Ok(written) => bytes = &bytes[written..],
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if poll(master.as_raw_fd(), libc::POLLOUT).is_err() {
                        return false;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => return false,
            }
        }
        true
    }
}
