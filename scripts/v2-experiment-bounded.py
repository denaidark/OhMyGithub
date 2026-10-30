#!/usr/bin/env python3
"""Bound and time one disposable V2 experiment command."""
import os
import signal
import subprocess
import sys
import time

seconds = float(sys.argv[1])
command = sys.argv[2:]
if seconds <= 0 or not command:
    raise SystemExit('Require a positive timeout and a command.')
start = time.monotonic()
proc = subprocess.Popen(command, start_new_session=True)
try:
    status = proc.wait(timeout=seconds)
except subprocess.TimeoutExpired:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait()
    print(f'{os.path.basename(command[0])} exceeded {seconds:g}s', file=sys.stderr)
    status = 124
finally:
    print(f'[timing] {os.path.basename(command[0])}: {time.monotonic() - start:.2f}s', file=sys.stderr)
raise SystemExit(status)
