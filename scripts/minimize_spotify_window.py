"""Minimize the Spotify desktop window on Linux (X11, or XWayland under a Wayland session).

Uses only libX11 through ctypes, so nothing has to be installed. Waits for a visible
window whose WM_CLASS is "Spotify", asks the window manager to iconify it, then exits.

Exit codes: 0 minimized, 2 no visible window appeared in time, 3 no X display available.
"""

import ctypes
import ctypes.util
import sys
import time

EXIT_MINIMIZED = 0
EXIT_NOT_FOUND = 2
EXIT_NO_DISPLAY = 3

WAIT_SECONDS = 20.0
POLL_SECONDS = 0.5
# root -> window-manager frame -> client window, plus one spare level.
MAX_DEPTH = 3
IS_VIEWABLE = 2
SPOTIFY_CLASS = b"spotify"

Window = ctypes.c_ulong


class XClassHint(ctypes.Structure):
    _fields_ = [("res_name", ctypes.c_char_p), ("res_class", ctypes.c_char_p)]


class XWindowAttributes(ctypes.Structure):
    _fields_ = [
        ("x", ctypes.c_int), ("y", ctypes.c_int), ("width", ctypes.c_int), ("height", ctypes.c_int),
        ("border_width", ctypes.c_int), ("depth", ctypes.c_int), ("visual", ctypes.c_void_p),
        ("root", Window), ("class_", ctypes.c_int), ("bit_gravity", ctypes.c_int),
        ("win_gravity", ctypes.c_int), ("backing_store", ctypes.c_int), ("backing_planes", ctypes.c_ulong),
        ("backing_pixel", ctypes.c_ulong), ("save_under", ctypes.c_int), ("colormap", ctypes.c_ulong),
        ("map_installed", ctypes.c_int), ("map_state", ctypes.c_int), ("all_event_masks", ctypes.c_long),
        ("your_event_mask", ctypes.c_long), ("do_not_propagate_mask", ctypes.c_long),
        ("override_redirect", ctypes.c_int), ("screen", ctypes.c_void_p),
    ]


def load_x11():
    library_path = ctypes.util.find_library("X11") or "libX11.so.6"
    x11 = ctypes.cdll.LoadLibrary(library_path)
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XDefaultRootWindow.restype = Window
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XDefaultScreen.argtypes = [ctypes.c_void_p]
    x11.XQueryTree.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(Window), ctypes.POINTER(Window),
                               ctypes.POINTER(ctypes.POINTER(Window)), ctypes.POINTER(ctypes.c_uint)]
    x11.XFree.argtypes = [ctypes.c_void_p]
    x11.XGetClassHint.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(XClassHint)]
    x11.XGetWindowAttributes.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(XWindowAttributes)]
    x11.XIconifyWindow.argtypes = [ctypes.c_void_p, Window, ctypes.c_int]
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    return x11


def children_of(x11, display, window):
    root_ret, parent_ret = Window(), Window()
    children = ctypes.POINTER(Window)()
    count = ctypes.c_uint()
    if not x11.XQueryTree(display, window, ctypes.byref(root_ret), ctypes.byref(parent_ret),
                          ctypes.byref(children), ctypes.byref(count)):
        return []
    result = [children[index] for index in range(count.value)]
    if children:
        x11.XFree(children)
    return result


def is_spotify(x11, display, window):
    hint = XClassHint()
    if not x11.XGetClassHint(display, window, ctypes.byref(hint)):
        return False
    return (hint.res_class or b"").lower() == SPOTIFY_CLASS


def is_viewable(x11, display, window):
    attributes = XWindowAttributes()
    return bool(x11.XGetWindowAttributes(display, window, ctypes.byref(attributes))) and attributes.map_state == IS_VIEWABLE


def find_visible_spotify_windows(x11, display, window, depth=0):
    # Spotify also owns a hidden "leader" window; only visible ones are worth iconifying.
    found = []
    for child in children_of(x11, display, window):
        if is_spotify(x11, display, child):
            if is_viewable(x11, display, child):
                found.append(child)
        elif depth < MAX_DEPTH:
            found.extend(find_visible_spotify_windows(x11, display, child, depth + 1))
    return found


def main():
    try:
        x11 = load_x11()
    except OSError as error:
        print(f"libX11 is not available: {error}", file=sys.stderr)
        return EXIT_NO_DISPLAY

    display = x11.XOpenDisplay(None)
    if not display:
        print("No X display (is this a pure Wayland session without XWayland?)", file=sys.stderr)
        return EXIT_NO_DISPLAY

    try:
        root = x11.XDefaultRootWindow(display)
        deadline = time.monotonic() + WAIT_SECONDS
        while time.monotonic() < deadline:
            windows = find_visible_spotify_windows(x11, display, root)
            if windows:
                screen = x11.XDefaultScreen(display)
                for window in windows:
                    x11.XIconifyWindow(display, window, screen)
                x11.XSync(display, 0)
                print(f"Minimized {len(windows)} Spotify window(s)")
                return EXIT_MINIMIZED
            time.sleep(POLL_SECONDS)
        print(f"No visible Spotify window appeared within {WAIT_SECONDS:.0f}s", file=sys.stderr)
        return EXIT_NOT_FOUND
    finally:
        x11.XCloseDisplay(display)


if __name__ == "__main__":
    sys.exit(main())
