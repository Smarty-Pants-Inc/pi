"""Own a real PTY master, as an attacking agent would (smarty-dev#2636 F1).

Usage: herdr-pty-host.py CMD [ARGS...]
Runs CMD on the slave as its controlling terminal (new session). Prints one JSON line
{"slave": path} on stdout, then writes each hex line read from stdin into the master.
Master output is drained and discarded. Prints {"exit": code} when CMD exits.
"""
import fcntl
import json
import os
import select
import sys
import termios

master, slave = os.openpty()
slave_path = os.ttyname(slave)
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for fd in (0, 1, 2):
        os.dup2(slave, fd)
    if slave > 2:
        os.close(slave)
    os.execvp(sys.argv[1], sys.argv[1:])

os.close(slave)
print(json.dumps({"slave": slave_path}), flush=True)
stdin_open = True
pending = b""
while True:
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        break
    readable = [master] + ([0] if stdin_open else [])
    ready, _, _ = select.select(readable, [], [], 0.05)
    if master in ready:
        try:
            os.read(master, 65536)
        except OSError:
            pass
    if 0 in ready:
        # Unbuffered: a buffered readline would hide a second queued line from select().
        data = os.read(0, 65536)
        if not data:
            stdin_open = False
        pending += data
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            if line.strip():
                os.write(master, bytes.fromhex(line.strip().decode()))
print(json.dumps({"exit": os.waitstatus_to_exitcode(status)}), flush=True)
