#!/usr/bin/env python3
"""Presses raw Linux keycodes via /dev/uinput (works on Wayland and X11).
usage: uinput_type.py KEY_DELAY_MS TOKEN...   TOKEN = "<code>:1" press, "<code>:0" release, "sleep:<ms>"
"""
import fcntl, os, struct, sys, time

UI_SET_EVBIT, UI_SET_KEYBIT, UI_DEV_SETUP, UI_DEV_CREATE, UI_DEV_DESTROY = 0x40045564, 0x40045565, 0x405C5503, 0x5501, 0x5502
EV_SYN, EV_KEY = 0, 1

def emit(fd, etype, code, value):
    os.write(fd, struct.pack('llHHi', 0, 0, etype, code, value))

key_delay = int(sys.argv[1]) / 1000
fd = os.open('/dev/uinput', os.O_WRONLY | os.O_NONBLOCK)
fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
for k in range(1, 249):
    fcntl.ioctl(fd, UI_SET_KEYBIT, k)
fcntl.ioctl(fd, UI_DEV_SETUP, struct.pack('<HHHH80sI', 3, 0x1234, 0x5678, 1, b'kyuch-autotype', 0))
fcntl.ioctl(fd, UI_DEV_CREATE)
try:
    time.sleep(0.5)  # let the compositor notice the new keyboard, or the first keys are lost
    for tok in sys.argv[2:]:
        name, val = tok.split(':')
        if name == 'sleep':
            time.sleep(int(val) / 1000)
            continue
        emit(fd, EV_KEY, int(name), int(val))
        emit(fd, EV_SYN, 0, 0)
        time.sleep(key_delay)
    time.sleep(0.2)
finally:
    fcntl.ioctl(fd, UI_DEV_DESTROY)
    os.close(fd)
