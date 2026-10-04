import base64
import ctypes as C
import json
import os
from pathlib import Path
import shlex
import subprocess as S
import sys
import time
import signal

# Real X11 selection owner. No app clipboard APIs or terminal renderer are replaced.
def own_selection(display, uri):
    x = C.CDLL('libX11.so.6')
    class Request(C.Structure):
        _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('send_event', C.c_int), ('display', C.c_void_p), ('owner', C.c_ulong), ('requestor', C.c_ulong), ('selection', C.c_ulong), ('target', C.c_ulong), ('property', C.c_ulong), ('time', C.c_ulong)]
    class Notify(C.Structure):
        _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('send_event', C.c_int), ('display', C.c_void_p), ('requestor', C.c_ulong), ('selection', C.c_ulong), ('target', C.c_ulong), ('property', C.c_ulong), ('time', C.c_ulong)]
    class Event(C.Union):
        _fields_ = [('request', Request), ('notify', Notify), ('pad', C.c_long * 24)]
    for name, args, result in [
        ('XOpenDisplay', [C.c_char_p], C.c_void_p),
        ('XDefaultRootWindow', [C.c_void_p], C.c_ulong),
        ('XCreateSimpleWindow', [C.c_void_p, C.c_ulong, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_uint, C.c_ulong, C.c_ulong], C.c_ulong),
        ('XInternAtom', [C.c_void_p, C.c_char_p, C.c_int], C.c_ulong),
        ('XSetSelectionOwner', [C.c_void_p, C.c_ulong, C.c_ulong, C.c_ulong], C.c_int),
        ('XSync', [C.c_void_p, C.c_int], C.c_int),
        ('XNextEvent', [C.c_void_p, C.POINTER(Event)], C.c_int),
        ('XChangeProperty', [C.c_void_p, C.c_ulong, C.c_ulong, C.c_ulong, C.c_int, C.c_int, C.c_void_p, C.c_int], C.c_int),
        ('XSendEvent', [C.c_void_p, C.c_ulong, C.c_int, C.c_long, C.POINTER(Event)], C.c_int),
        ('XFlush', [C.c_void_p], C.c_int),
    ]:
        fn = getattr(x, name); fn.argtypes = args; fn.restype = result
    d = x.XOpenDisplay(display.encode()); assert d
    window = x.XCreateSimpleWindow(d, x.XDefaultRootWindow(d), 0, 0, 1, 1, 0, 0, 0)
    atoms = {name: x.XInternAtom(d, name.encode(), 0) for name in ['CLIPBOARD', 'TARGETS', 'text/uri-list', 'image/png', 'ATOM']}
    x.XSetSelectionOwner(d, atoms['CLIPBOARD'], window, 0); x.XSync(d, 0)
    print('ready', flush=True)
    while True:
        event = Event(); x.XNextEvent(d, C.byref(event))
        if event.request.type != 30: continue
        r = event.request
        prop = r.property or r.target
        if r.target == atoms['TARGETS']:
            data = (C.c_ulong * 2)(atoms['text/uri-list'], atoms['image/png'])
            x.XChangeProperty(d, r.requestor, prop, atoms['ATOM'], 32, 0, C.cast(data, C.c_void_p), 2)
        elif r.target == atoms['text/uri-list']:
            data = (uri + '\r\n').encode(); buffer = C.create_string_buffer(data)
            x.XChangeProperty(d, r.requestor, prop, r.target, 8, 0, C.cast(buffer, C.c_void_p), len(data))
        elif r.target == atoms['image/png']:
            data = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='); buffer = C.create_string_buffer(data)
            x.XChangeProperty(d, r.requestor, prop, r.target, 8, 0, C.cast(buffer, C.c_void_p), len(data))
        else: prop = 0
        response = Event(); response.notify = Notify(31, 0, 1, d, r.requestor, r.selection, r.target, prop, r.time)
        x.XSendEvent(d, r.requestor, 0, 0, C.byref(response)); x.XFlush(d)

if len(sys.argv) > 1 and sys.argv[1] == '--owner':
    own_selection(sys.argv[2], sys.argv[3]); sys.exit(0)

root = Path(sys.argv[1]).resolve()
scratch = Path(sys.argv[2]).resolve()
out = Path(sys.argv[3]).resolve()
widget = Path(sys.argv[4]).resolve()
out.mkdir(parents=True, exist_ok=True)
home = scratch / 'cli-home'; home.mkdir(exist_ok=True)
work = scratch / 'cli-work'; work.mkdir(exist_ok=True)
file = work / "native space $(touch injected)'file.png"; file.write_bytes(b'image fixture')
env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'TMPDIR': str(scratch), 'TASK_OUT': str(out), 'LANG': 'C.UTF-8', 'TERM': 'xterm-256color', 'PI_CODING_AGENT_DIR': str(home / '.pi/agent'), 'PI_OFFLINE': '1', 'PI_TELEMETRY': '0', 'PI_NO_LOCAL_LLM': '1', 'AWS_EC2_METADATA_DISABLED': 'true', 'PI_IMAGE_PROTOCOL': 'kitty', 'WEZTERM_PANE': '1'}
xvfb = None; owner = None
socket = str(scratch / 'proof-tmux.sock')
steps = []
def tmux(*args, check=True):
    return S.run(['tmux', '-S', socket, *args], env=env, text=True, capture_output=True, check=check, timeout=10).stdout

def capture(): return tmux('capture-pane', '-t', 'proof', '-p', '-J', '-S', '-100')
def wait_text(text, name):
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        pane = capture()
        if text in pane:
            (out / (name + '.txt')).write_text(pane)
            steps.append({'step': name, 'expected': text, 'passed': True})
            return pane
        time.sleep(.1)
    (out / (name + '.txt')).write_text(pane)
    raise AssertionError('Timed out waiting for ' + text + '\n' + pane)

def send(text): tmux('send-keys', '-t', 'proof', '-l', text)
def command(text): send(text); tmux('send-keys', '-t', 'proof', 'Enter')

def start(name):
    env['PI_TUI_WRITE_LOG'] = str(out / (name + '.ansi'))
    argv = ['nice', '-n', '19', 'node']
    argv += ['--import', str(root / 'packages/coding-agent/src/experimental/source-resolver.ts'), str(root / 'packages/coding-agent/src/experimental/cli.ts'), '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--tui-mode', 'fullscreen', '-e', str(widget)]
    launch = shlex.join(['env', '-i', *[k + '=' + v for k, v in env.items()], *argv])
    steps.append({'step': 'launch-' + name, 'argv': argv, 'cwd': str(work), 'environment': env.copy()})
    tmux('new-session', '-d', '-s', 'proof', '-x', '100', '-y', '28', '-c', str(work), launch)
    wait_text(widget.name, name + '-startup')

def quit_app():
    tmux('send-keys', '-t', 'proof', 'C-u'); command('/quit')
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        result = S.run(['tmux', '-S', socket, 'has-session', '-t', 'proof'], env=env, capture_output=True, timeout=5)
        if result.returncode != 0: return
        time.sleep(.1)
    raise AssertionError('CLI did not terminate after /quit')

def timed_out(_signum, _frame): raise TimeoutError('Real CLI proof exceeded its bounded deadline')
signal.signal(signal.SIGALRM, timed_out)
signal.signal(signal.SIGTERM, timed_out)
signal.alarm(75)
try:
    xvfb = S.Popen(['Xvfb', '-displayfd', '1', '-screen', '0', '640x480x24', '-nolisten', 'tcp'], env=env, stdout=S.PIPE, stderr=S.PIPE, text=True)
    display = xvfb.stdout.readline().strip(); assert display.isdigit(), 'Xvfb failed to start'
    env['DISPLAY'] = ':' + display
    owner = S.Popen([sys.executable, __file__, '--owner', env['DISPLAY'], file.as_uri()], env=env, stdout=S.PIPE, stderr=S.PIPE, text=True)
    assert owner.stdout.readline().strip() == 'ready', 'X11 selection owner failed'
    steps.append({'step': 'native-path', 'passed': False, 'excluded': 'Linux source and shipped helper export only getText/getImage; getFilePaths is exported by the Darwin helper. Native file-path proof requires Darwin.'})
    cliptemp = scratch / "clip temp $(touch injected)'dir"; cliptemp.mkdir(exist_ok=True)
    env['TMPDIR'] = str(cliptemp)
    start('clipboard-image')
    send('Review:'); tmux('send-keys', '-t', 'proof', 'C-v')
    wait_text('pi-clipboard-', 'clipboard-image-pasted')
    tmux('send-keys', '-t', 'proof', 'C-u'); send('!ls '); tmux('send-keys', '-t', 'proof', 'C-v')
    wait_text('pi-clipboard-', 'clipboard-image-bash-pasted')
    tmux('send-keys', '-t', 'proof', 'Enter')
    wait_text('pi-clipboard-', 'clipboard-image-bash-result')
    time.sleep(.5)
    pane = capture(); (out / 'clipboard-image-bash-completed.txt').write_text(pane)
    assert 'No such file' not in pane and 'Failed to' not in pane and '(exit ' not in pane and 'unexpected EOF' not in pane, pane
    assert pane.count('pi-clipboard-') >= 2, 'Bash must show both its command and the successful ls output'
    assert not (work / 'injected').exists(), 'Pasted shell syntax executed'
    quit_app()
    start('fullscreen-image')
    command('/proof-image'); wait_text('A15-before', 'fullscreen-image-starting-state')
    before = (out / 'fullscreen-image.ansi').read_bytes()
    assert b'9007199254740991' in before, 'Real app did not draw the hostile image row'
    command('/proof-redraw'); wait_text('A15-changed', 'fullscreen-image-redrawn')
    after = (out / 'fullscreen-image.ansi').read_bytes()
    assert len(after) > len(before) and b'A15-changed' in after
    quit_app()
    steps.append({'step': 'result', 'passed': True, 'scope': 'real source CLI, native X11 image fallback and actual fullscreen renderer; native file-path proof excluded on Linux; no model or credentials'})
    print(json.dumps({'passed': True, 'steps': len(steps), 'out': str(out)}))
finally:
    signal.alarm(0)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    S.run(['tmux', '-S', socket, 'kill-server'], env=env, capture_output=True, timeout=10)
    for child in [owner, xvfb]:
        if child is not None:
            if child.poll() is None: child.terminate()
            try: child.wait(timeout=5)
            except S.TimeoutExpired: child.kill(); child.wait(timeout=5)
    (out / 'steps.json').write_text(json.dumps(steps, indent=2) + '\n')
