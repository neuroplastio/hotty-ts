"""Runs a command on a pty that is its controlling terminal, and answers as a
hotty host does: the query with the reply in a file, DA1, and the cursor's
position. Prints the exit status and everything the command wrote, as JSON.

    python3 pty-driver.py tty|pipe REPLY-FILE COMMAND...

With pipe, the command's stdin is a pipe, so it can reach its terminal
only by opening /dev/tty.
"""

import base64
import fcntl
import json
import os
import re
import select
import subprocess
import sys
import termios
import time

mode, reply_file, cmd = sys.argv[1], sys.argv[2], sys.argv[3:]
reply = open(reply_file, "rb").read()
master, slave = os.openpty()


def controlling_terminal():
    # After the new session: the pty, as stdout, becomes its terminal.
    fcntl.ioctl(1, termios.TIOCSCTTY, 0)


p = subprocess.Popen(
    cmd,
    stdin=slave if mode == "tty" else subprocess.PIPE,
    stdout=slave,
    stderr=slave,
    start_new_session=True,
    preexec_fn=controlling_terminal,
)
os.close(slave)

answers = re.compile(rb"\x1b\]7279;a=q[^\x1b]*\x1b\\|\x1b\[c|\x1b\[6n")
out = b""
seen = 0
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    r, _, _ = select.select([master], [], [], 0.05)
    if r:
        try:
            chunk = os.read(master, 65536)
        except OSError:  # the pty closed
            chunk = b""
        if not chunk and p.poll() is not None:
            break
        out += chunk
        for m in answers.finditer(out, seen):
            seq = m.group(0)
            if seq.startswith(b"\x1b]"):
                os.write(master, reply)
            elif seq == b"\x1b[c":
                os.write(master, b"\x1b[?62;22c")
            else:
                os.write(master, b"\x1b[1;1R")
            seen = m.end()
    elif p.poll() is not None:
        break
if p.poll() is None:
    p.kill()
code = p.wait()
print(json.dumps({"code": code, "out": base64.b64encode(out).decode()}))
