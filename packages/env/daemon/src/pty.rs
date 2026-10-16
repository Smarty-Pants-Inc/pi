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

/// After the program exits, output still arriving is collected until this much silence.
#[cfg(unix)]
const EXIT_GRACE: std::time::Duration = std::time::Duration::from_millis(100);
#[cfg(unix)]
const CLEANUP_TERM_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
#[cfg(unix)]
const CLEANUP_KILL_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
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
        // Observe only: the request retains Child and the unreaped leader pins its PID/PGID.
        let _ = waiter.send(match unix::wait_for_exit(pid) {
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
    let mut cleanup = None;
    let mut terminate = |observation_failed| {
        cleanup_group(
            pid,
            groups,
            || {
                if observation_failed {
                    // Without an exit observation, do not assume a raw PGID is still ours.
                    GroupTermination {
                        confirmed: false,
                        error: Some(std::io::Error::other("leader exit observation failed")),
                    }
                } else {
                    unix::terminate_group(pid)
                }
            },
            || unix::reap(&mut child),
            |message| eprintln!("pty: ERROR {message}"),
        )
    };
    let kill = |killed: &mut bool| {
        if !*killed {
            *killed = true;
            // The observer never reaps, even on cancel: the live or zombie leader still pins this PGID.
            // Exit fences this closure before reaping; WaitFailed breaks without processing another message.
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
                // Cleanup starts at leader exit, not after background output becomes idle.
                // Fence later cancel/kill messages before forgetting this group.
                killed = true;
                cleanup = Some(terminate(false));
                if cleanup.as_ref().is_some_and(Result::is_err) {
                    break;
                }
                idle_until = Some(Instant::now() + EXIT_GRACE);
            }
            Ok(Message::WaitFailed(error)) => {
                // Break immediately: no cancel/kill is processed after this cleanup/reap.
                cleanup = Some(terminate(true));
                status = Some(Err(error));
                break;
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
    // A disconnected waiter still gets one bounded attempt, never a deferred retry.
    let cleanup = cleanup.unwrap_or_else(|| terminate(false));
    stop.store(true, Ordering::SeqCst);
    // Ending the input channel ends the writer thread.
    terminals.lock().unwrap().remove(&id);
    let _ = reader.join();
    let _ = writer.join();
    cleanup?;
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
#[derive(Debug)]
struct GroupTermination {
    confirmed: bool,
    error: Option<std::io::Error>,
}

#[cfg(unix)]
fn cleanup_group(
    pid: u32,
    groups: &Groups,
    terminate: impl FnOnce() -> GroupTermination,
    reap: impl FnOnce() -> std::io::Result<()>,
    log_error: impl FnOnce(&str),
) -> Result<(), Failure> {
    // Keep shutdown from signalling between the last group signal, reaping, and record removal.
    // The unreaped leader reserves the PID/PGID for the entire bounded cleanup, including failure.
    let mut groups = groups.lock().unwrap();
    let outcome = terminate();
    let reaped = if outcome.confirmed {
        let reaped = reap();
        // Once reaping can release the identity pin, no subsequent shutdown signal may use this PGID.
        groups.remove(&pid);
        Some(reaped)
    } else {
        // Dropping std::process::Child does not reap it. Keep the leader and its record pinned until
        // daemon shutdown; never start a worker or release ownership of an unconfirmed group.
        None
    };
    drop(groups);
    if outcome.error.is_none() && matches!(reaped, Some(Ok(()))) {
        return Ok(());
    }
    let disposition = if outcome.confirmed {
        "group cleanup confirmed; supervision released without retry"
    } else {
        "retaining unreaped leader and supervision until daemon shutdown; no background retry"
    };
    let message = format!(
        "PTY process group {pid} cleanup incomplete ({outcome:?}, reap {reaped:?}); {disposition}"
    );
    log_error(&message);
    Err(Failure::new("cleanup_failed", message))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    // pi#244: a confirmed-empty group is removed synchronously, with no cleanup worker.
    #[test]
    fn cleanup_success_removes_record_without_worker() {
        let groups: Groups = Arc::new(Mutex::new(Default::default()));
        let pid = 123;
        groups.lock().unwrap().insert(pid);
        let caller = std::thread::current().id();
        let mut attempts = 0;
        cleanup_group(
            pid,
            &groups,
            || {
                assert_eq!(std::thread::current().id(), caller);
                attempts += 1;
                GroupTermination {
                    confirmed: true,
                    error: None,
                }
            },
            || Ok(()),
            |_| panic!("successful cleanup must not log an error"),
        )
        .unwrap();
        assert_eq!(attempts, 1);
        assert!(groups.lock().unwrap().is_empty());
    }

    // pi#244: failed cleanup logs once and keeps the unreaped leader/record until cleanup is confirmed.
    #[test]
    fn cleanup_failure_logs_once_and_retains_record_and_leader() {
        for outcome in [
            Ok(false),
            Err(std::io::Error::from_raw_os_error(libc::EPERM)),
        ] {
            let groups: Groups = Arc::new(Mutex::new(Default::default()));
            let request = PtyRequest::from_json(&json!({
                "argv": ["/bin/sh", "-c", "exit 0"],
                "cwd": crate::sys::tmpdir(), "cols": 80, "rows": 24,
            }))
            .unwrap();
            let (_master, mut child) = unix::spawn(&request).unwrap();
            let pid = child.id();
            unix::wait_for_exit(pid).unwrap();
            groups.lock().unwrap().insert(pid);
            let caller = std::thread::current().id();
            let attempts = std::cell::Cell::new(0);
            let mut logs = Vec::new();
            let reaps = std::cell::Cell::new(0);
            let error = cleanup_group(
                pid,
                &groups,
                || {
                    assert_eq!(std::thread::current().id(), caller);
                    attempts.set(attempts.get() + 1);
                    // A repeated WNOWAIT observation proves cleanup still owns an unreaped leader.
                    assert_eq!(unix::wait_for_exit(pid).unwrap().code(), Some(0));
                    #[cfg(target_os = "linux")]
                    assert!(
                        std::fs::read_to_string(format!("/proc/{pid}/stat"))
                            .unwrap()
                            .rsplit_once(") ")
                            .unwrap()
                            .1
                            .starts_with('Z')
                    );
                    GroupTermination {
                        confirmed: matches!(outcome, Ok(true)),
                        error: outcome.err(),
                    }
                },
                || {
                    reaps.set(reaps.get() + 1);
                    unix::reap(&mut child)
                },
                |message| logs.push(message.to_string()),
            )
            .unwrap_err();
            let pinned = unix::wait_for_exit(pid).is_ok();
            let retained = groups.lock().unwrap().contains(&pid);
            // The test owns the exited child, and must not leak its pin on either implementation.
            unix::reap(&mut child).unwrap();
            groups.lock().unwrap().remove(&pid);
            assert_eq!(error.code, "cleanup_failed");
            assert!(error.message.contains(&pid.to_string()));
            assert_eq!(logs, [error.message]);
            assert_eq!(attempts.get(), 1);
            assert_eq!(
                reaps.get(),
                0,
                "unconfirmed cleanup must not reap its leader"
            );
            assert!(pinned, "unconfirmed cleanup released the PGID pin");
            assert!(retained, "unconfirmed cleanup dropped the ownership record");
        }
    }

    // pi#244: a recovered TERM probe error remains visible even after hard-stop cleanup is confirmed.
    #[test]
    fn confirmed_cleanup_preserves_probe_error_and_logs_once() {
        let groups: Groups = Arc::new(Mutex::new(Default::default()));
        let pid = 123;
        groups.lock().unwrap().insert(pid);
        let mut reaps = 0;
        let mut logs = Vec::new();
        let error = cleanup_group(
            pid,
            &groups,
            || GroupTermination {
                confirmed: true,
                error: Some(std::io::Error::other("injected TERM probe error")),
            },
            || {
                reaps += 1;
                Ok(())
            },
            |message| logs.push(message.to_string()),
        )
        .unwrap_err();
        assert_eq!(reaps, 1);
        assert_eq!(error.code, "cleanup_failed");
        assert!(error.message.contains("injected TERM probe error"));
        assert_eq!(logs, [error.message]);
        assert!(groups.lock().unwrap().is_empty());
    }

    // pi#244: WNOWAIT must preserve both ordinary and signalled exit status until the request reaps.
    #[test]
    fn exit_observation_preserves_status_without_reaping() {
        for (command, expected) in [("exit 23", 23), ("kill -KILL $$", 137)] {
            let request = PtyRequest::from_json(&json!({
                "argv": ["/bin/sh", "-c", command],
                "cwd": crate::sys::tmpdir(), "cols": 80, "rows": 24,
            }))
            .unwrap();
            let (_master, mut child) = unix::spawn(&request).unwrap();
            let observed = unix::wait_for_exit(child.id()).unwrap();
            let repeated = unix::wait_for_exit(child.id()).unwrap();
            let reaped = child.wait().unwrap();
            assert_eq!(crate::sys::exit_code(observed), expected);
            assert_eq!(observed, repeated);
            assert_eq!(observed, reaped);
        }
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

    // pi#244: queued exit cleanup must keep the leader's PID/PGID reserved until its last signal.
    #[test]
    #[cfg(target_os = "linux")]
    fn leader_stays_zombie_until_group_cleanup_returns() {
        use std::os::unix::net::UnixStream;
        use std::thread;
        use std::time::{Duration, Instant};

        let output = Arc::new(Output::default());
        let control = Arc::new(Control::default());
        let groups: Groups = Arc::new(Mutex::new(Default::default()));
        let terminals = Arc::new(Mutex::new(HashMap::new()));
        let (mut events, mut sink) = UnixStream::pair().unwrap();
        events
            .set_read_timeout(Some(Duration::from_secs(5)))
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
                    "argv": ["/bin/sh", "-c", "trap '' HUP TERM; read trigger; sleep 30 & echo $!; exit 7"],
                    "cwd": crate::sys::tmpdir(), "cols": 80, "rows": 24,
                })).unwrap();
                run(8, request, &output, &control, &groups, &terminals)
            })
        };
        let started = crate::frame::read_frame(&mut events).unwrap().unwrap();
        let pid = started.json["pid"].as_u64().unwrap() as u32;
        // Hold cleanup at its real entry point, then let the leader exit.
        let record = groups.lock().unwrap();
        write(&terminals, &json!({ "target": 8 }), b"go\n".to_vec()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let zombie = loop {
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok();
            if stat
                .as_ref()
                .is_some_and(|stat| stat.rsplit_once(") ").unwrap().1.starts_with('Z'))
            {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            thread::sleep(Duration::from_millis(10));
        };
        drop(record);
        // The background child ignores TERM, so the real bounded cleanup is now waiting before SIGKILL.
        thread::sleep(Duration::from_millis(100));
        let pinned_during_cleanup = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .is_some_and(|stat| stat.rsplit_once(") ").unwrap().1.starts_with('Z'));
        // Always release the lock and clean up before assertions, also on the unfixed implementation.
        let result = worker.join().unwrap();
        output.close();
        let mut text = Vec::new();
        while let Some(frame) = crate::frame::read_frame(&mut events).unwrap() {
            text.extend(frame.payload);
        }
        writer.join().unwrap();
        let background = String::from_utf8(text)
            .unwrap()
            .lines()
            .find_map(|line| line.trim().parse::<u32>().ok())
            .unwrap();
        let background_live = std::fs::read_to_string(format!("/proc/{background}/stat"))
            .ok()
            .is_some_and(|stat| !stat.rsplit_once(") ").unwrap().1.starts_with('Z'));
        if background_live {
            // SAFETY: the test owns this background child; do not leak it on regression.
            unsafe {
                libc::kill(background as libc::pid_t, libc::SIGKILL);
            }
        }
        assert!(
            zombie,
            "leader {pid} was reaped before cleanup acquired the group lock"
        );
        assert!(
            pinned_during_cleanup,
            "leader {pid} was reaped during the bounded group cleanup"
        );
        assert_eq!(result.unwrap()["exitCode"], 7);
        assert!(!background_live, "background child survived group cleanup");
        assert!(
            !std::path::Path::new(&format!("/proc/{pid}")).exists(),
            "leader was not reaped after cleanup"
        );
        assert!(groups.lock().unwrap().is_empty());
        assert!(terminals.lock().unwrap().is_empty());
    }

    // pi#244: cleanup starts on leader exit even while a background job keeps producing output.
    #[test]
    fn shutdown_terminates_background_job() {
        let output = Arc::new(Output::default());
        let groups = Arc::new(Mutex::new(Default::default()));
        let terminals = Arc::new(Mutex::new(HashMap::new()));
        let request = PtyRequest::from_json(&json!({
            "argv": ["/bin/sh", "-c", "trap '' HUP TERM; (sleep 0.1; while :; do printf 'busy\\n'; sleep 0.01; done) & echo $!; exit 0"],
            "cwd": crate::sys::tmpdir(), "cols": 80, "rows": 24,
        }))
        .unwrap();
        let started = std::time::Instant::now();
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
        let pid: i32 = String::from_utf8(text)
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .trim()
            .parse()
            .unwrap();
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
        assert!(
            started.elapsed()
                < CLEANUP_TERM_WAIT + CLEANUP_KILL_WAIT + std::time::Duration::from_secs(2)
        );
        assert!(!live, "background job {pid} survived the PTY request");
        assert!(terminals.lock().unwrap().is_empty());
        assert!(groups.lock().unwrap().is_empty());
    }
}

#[cfg(unix)]
mod unix {
    use super::{GroupTermination, PtyRequest};
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

    /// Report the leader's exit without releasing its PID or PGID. Only the request may reap it, after cleanup.
    pub fn wait_for_exit(pid: u32) -> io::Result<std::process::ExitStatus> {
        use std::os::unix::process::ExitStatusExt;

        loop {
            // SAFETY: waitid initializes one siginfo_t for the exact child; WNOWAIT preserves the zombie.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT,
                )
            };
            if result < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            // SAFETY: a successful WEXITED waitid initializes the child PID and exit status fields.
            if unsafe { info.si_pid() } != pid as libc::pid_t {
                return Err(io::Error::other("waitid returned a different child"));
            }
            let status = unsafe { info.si_status() };
            let raw = match info.si_code {
                libc::CLD_EXITED => status << 8,
                libc::CLD_KILLED => status,
                libc::CLD_DUMPED => status | 0x80,
                _ => return Err(io::Error::other("waitid did not report an exit")),
            };
            return Ok(std::process::ExitStatus::from_raw(raw));
        }
    }

    /// Reap only after the final group signal. Also bounded when exit observation or cleanup failed.
    pub fn reap(child: &mut Child) -> io::Result<()> {
        use std::thread;
        use std::time::{Duration, Instant};

        let deadline = Instant::now() + super::CLEANUP_KILL_WAIT;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "PTY leader did not exit before reap deadline",
                ));
            }
            thread::sleep(
                Duration::from_millis(10).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }

    // A zombie-only group still passes kill(-pgid, 0). Inspect live members without waitpid(-pgid), which would
    // reap the leader and release the identity pin before SIGKILL. Orphan zombies are left for their parent/init.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    fn group_has_live_members(pid: u32, deadline: std::time::Instant) -> io::Result<bool> {
        for entry in std::fs::read_dir("/proc")? {
            if std::time::Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "PTY group probe exceeded deadline",
                ));
            }
            let entry = entry?;
            let Some(member) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<libc::pid_t>().ok())
            else {
                continue;
            };
            if member == pid as libc::pid_t {
                continue;
            }
            // SAFETY: read-only membership query; the leader reserves the group identity throughout this scan.
            let group = unsafe { libc::getpgid(member) };
            if group < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    continue;
                }
                return Err(error);
            }
            if group != pid as libc::pid_t {
                continue;
            }
            let stat = match std::fs::read_to_string(entry.path().join("stat")) {
                Ok(stat) => stat,
                Err(error)
                    if matches!(error.raw_os_error(), Some(libc::ENOENT) | Some(libc::ESRCH)) =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            };
            let mut fields = stat
                .rsplit_once(") ")
                .ok_or_else(|| io::Error::other("invalid process stat"))?
                .1
                .split_whitespace();
            let state = fields
                .next()
                .ok_or_else(|| io::Error::other("missing process state"))?;
            let group = fields
                .nth(1)
                .and_then(|group| group.parse::<u32>().ok())
                .ok_or_else(|| io::Error::other("missing process group"))?;
            if group == pid && !matches!(state, "Z" | "X") {
                return Ok(true);
            }
        }
        Ok(false)
    }

    #[cfg(target_os = "macos")]
    fn group_has_live_members(pid: u32, deadline: std::time::Instant) -> io::Result<bool> {
        let mut members = [0 as libc::pid_t; 4096];
        let capacity = std::mem::size_of_val(&members) as libc::c_int;
        // libproc.h's PROC_PGRP_ONLY is not exposed by libc; proc_listpids returns bytes (not a PID count).
        const PROC_PGRP_ONLY: u32 = 2;
        // SAFETY: libproc fills the PID array with at most capacity bytes.
        let bytes = unsafe {
            libc::proc_listpids(PROC_PGRP_ONLY, pid, members.as_mut_ptr().cast(), capacity)
        };
        if bytes <= 0 {
            return Err(io::Error::last_os_error());
        }
        if bytes >= capacity {
            return Err(io::Error::other(
                "PTY group member list exceeded probe capacity",
            ));
        }
        for member in members
            .into_iter()
            .take(bytes as usize / std::mem::size_of::<libc::pid_t>())
        {
            if std::time::Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "PTY group probe exceeded deadline",
                ));
            }
            if member <= 0 || member == pid as libc::pid_t {
                continue;
            }
            // SAFETY: proc_pidinfo initializes one BSD process record in the supplied buffer.
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of_val(&info) as libc::c_int;
            let read = unsafe {
                libc::proc_pidinfo(
                    member,
                    libc::PROC_PIDTBSDINFO,
                    0,
                    (&mut info as *mut libc::proc_bsdinfo).cast(),
                    size,
                )
            };
            if read != size {
                let error = io::Error::last_os_error();
                if matches!(error.raw_os_error(), Some(libc::ESRCH) | Some(libc::ENOENT)) {
                    continue;
                }
                return Err(error);
            }
            if info.pbi_pgid == pid && info.pbi_status != libc::SZOMB {
                return Ok(true);
            }
        }
        Ok(false)
    }

    #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
    fn group_has_live_members(_pid: u32, _deadline: std::time::Instant) -> io::Result<bool> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "PTY live group probing is unsupported on this system",
        ))
    }

    /// Stop remaining jobs while the leader is still unreaped. Never reap any group member during this attempt.
    pub fn terminate_group(pid: u32) -> GroupTermination {
        terminate_group_with_probe(pid, |deadline| group_has_live_members(pid, deadline))
    }

    fn terminate_group_with_probe(
        pid: u32,
        mut probe: impl FnMut(std::time::Instant) -> io::Result<bool>,
    ) -> GroupTermination {
        use std::thread;
        use std::time::{Duration, Instant};

        let mut outcome = GroupTermination {
            confirmed: false,
            error: None,
        };
        let group = -(pid as libc::pid_t);
        for (signal, bound) in [
            (libc::SIGTERM, super::CLEANUP_TERM_WAIT),
            (libc::SIGKILL, super::CLEANUP_KILL_WAIT),
        ] {
            // SAFETY: the unreaped leader pins the process group this terminal owns until cleanup returns.
            if unsafe { libc::kill(group, signal) } != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    outcome.confirmed = true;
                    return outcome;
                }
                outcome.error.get_or_insert(error);
                continue;
            }
            let deadline = Instant::now() + bound;
            loop {
                if Instant::now() >= deadline {
                    break;
                }
                match probe(deadline) {
                    Ok(false) => {
                        outcome.confirmed = true;
                        return outcome;
                    }
                    Ok(true) => {}
                    Err(error) => {
                        // A failed TERM probe is not proof of emptiness. Preserve the first error,
                        // but always advance to the bounded SIGKILL pass with the leader still pinned.
                        outcome.error.get_or_insert(error);
                        break;
                    }
                }
                thread::sleep(
                    Duration::from_millis(10)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
        }
        outcome
    }

    #[cfg(all(test, target_os = "linux"))]
    mod cleanup_tests {
        use super::*;

        // pi#244: a TERM probe error must not strand a job that ignores TERM/HUP.
        #[test]
        fn term_probe_error_still_kills_member_before_reaping_leader() {
            for error_kind in [io::ErrorKind::Other, io::ErrorKind::TimedOut] {
                let request = PtyRequest::from_json(&serde_json::json!({
                    "argv": ["/bin/sh", "-c", "trap '' HUP TERM; sleep 30 & echo $!; exit 0"],
                    "cwd": crate::sys::tmpdir(), "cols": 80, "rows": 24,
                }))
                .unwrap();
                let (master, mut child) = spawn(&request).unwrap();
                let pid = child.id();
                wait_for_exit(pid).unwrap();
                let mut bytes = [0; 64];
                let read = (&master).read(&mut bytes).unwrap();
                let member: u32 = std::str::from_utf8(&bytes[..read])
                    .unwrap()
                    .trim()
                    .parse()
                    .unwrap();
                let mut probes = 0;
                let started = std::time::Instant::now();
                let outcome = terminate_group_with_probe(pid, |deadline| {
                    probes += 1;
                    if probes == 1 {
                        Err(io::Error::new(error_kind, "injected TERM probe failure"))
                    } else {
                        group_has_live_members(pid, deadline)
                    }
                });
                let member_stat = std::fs::read_to_string(format!("/proc/{member}/stat")).ok();
                let member_live = member_stat
                    .as_ref()
                    .is_some_and(|stat| !stat.rsplit_once(") ").unwrap().1.starts_with('Z'));
                let killed = member_stat.as_ref().is_none_or(|stat| {
                    stat.rsplit_once(") ").unwrap().1.split_whitespace().last() == Some("9")
                });
                let pinned = std::fs::read_to_string(format!("/proc/{pid}/stat"))
                    .unwrap()
                    .rsplit_once(") ")
                    .unwrap()
                    .1
                    .starts_with('Z');
                // Always clean up our original pinned group, including on the fail-first implementation.
                // SAFETY: this test retains the unreaped leader's Child and owns every member in this group.
                unsafe {
                    libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
                }
                reap(&mut child).unwrap();
                assert!(
                    !member_live,
                    "TERM-ignoring member survived the probe error"
                );
                assert!(killed, "member did not receive SIGKILL");
                assert!(pinned, "leader was reaped before the hard-stop pass");
                assert!(probes > 1, "hard-stop pass did not confirm cleanup");
                assert!(
                    outcome.confirmed,
                    "hard-stop pass did not confirm member death"
                );
                assert!(
                    outcome
                        .error
                        .unwrap()
                        .to_string()
                        .contains("injected TERM probe failure")
                );
                assert!(
                    started.elapsed()
                        < super::super::CLEANUP_TERM_WAIT
                            + super::super::CLEANUP_KILL_WAIT
                            + std::time::Duration::from_secs(1)
                );
            }
        }
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
