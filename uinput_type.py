#!/usr/bin/env python3
"""Presses raw Linux keycodes via /dev/uinput (works on Wayland and X11).

Input arrives on STDIN, never on the command line (a command line is readable by every process of the same user, and these
keycodes spell out the password):
    line 1:      key delay in milliseconds
    other lines: "<code>:1" press, "<code>:0" release, or "sleep:<ms>"
"""
import fcntl, os, struct, sys, time

UI_SET_EVBIT, UI_SET_KEYBIT, UI_DEV_SETUP, UI_DEV_CREATE, UI_DEV_DESTROY = 0x40045564, 0x40045565, 0x405C5503, 0x5501, 0x5502
EV_SYN, EV_KEY = 0, 1
MAX_SLEEP_MS = 60_000


def parse(text):
    """-> (key_delay_seconds, [(code, value) | ('sleep', seconds)]); raises ValueError on anything malformed."""
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if not lines:
        raise ValueError('no input')
    delay = int(lines[0])
    if not 0 <= delay <= 1000:
        raise ValueError('bad key delay')
    out = []
    for tok in lines[1:]:
        name, val = tok.split(':')
        if name == 'sleep':
            ms = int(val)
            if not 0 <= ms <= MAX_SLEEP_MS:
                raise ValueError('bad sleep')
            out.append(('sleep', ms / 1000))
        else:
            code, value = int(name), int(val)
            if not 1 <= code <= 248 or value not in (0, 1):
                raise ValueError('bad key event')
            out.append((code, value))
    return delay / 1000, out


def emit(fd, etype, code, value):
    os.write(fd, struct.pack('llHHi', 0, 0, etype, code, value))


def main():
    key_delay, events = parse(sys.stdin.read())
    fd = os.open('/dev/uinput', os.O_WRONLY | os.O_NONBLOCK)
    fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
    for k in range(1, 249):
        fcntl.ioctl(fd, UI_SET_KEYBIT, k)
    fcntl.ioctl(fd, UI_DEV_SETUP, struct.pack('<HHHH80sI', 3, 0x1234, 0x5678, 1, b'kyuch-autotype', 0))
    fcntl.ioctl(fd, UI_DEV_CREATE)
    try:
        time.sleep(0.5)  # let the compositor notice the new keyboard, or the first keys are lost
        for code, value in events:
            if code == 'sleep':
                time.sleep(value)
                continue
            emit(fd, EV_KEY, code, value)
            emit(fd, EV_SYN, 0, 0)
            time.sleep(key_delay)
        time.sleep(0.2)
    finally:
        fcntl.ioctl(fd, UI_DEV_DESTROY)
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except ValueError as e:
        sys.exit('Invalid auto-type data: ' + str(e))
