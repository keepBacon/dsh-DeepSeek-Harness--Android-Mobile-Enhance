"""Android DSH Python subprocess W^X adapter.

Loaded from an Android-only .pth entry in the embedded Termux interpreter.
Redirect ONLY commands selected from this app's noexec files or Python's
known /usr/bin/python[3] host misreference. Use the existing system shell and
linker bridge; never intercept global execution, /system, /apex or other apps.
"""
import os
import re
import shutil
import subprocess

_PREFIX = re.compile(r"^/data/(?:data|user/[0-9]+)/[^/]+/files/usr/?$")
_PATCHED = False


def _under(path, root):
    return bool(root) and (path == root or path.startswith(root + "/"))


def _selected(args, prefix, home, env):
    if isinstance(args, (str, bytes, os.PathLike)):
        try:
            command = os.fsdecode(args)
        except (TypeError, ValueError):
            return None
        argv = [command]
    elif isinstance(args, (list, tuple)) and args:
        try:
            argv = [os.fsdecode(arg) for arg in args]
        except (TypeError, ValueError):
            return None
        command = argv[0]
    else:
        return None
    if not command or "\x00" in command:
        return None

    # Some build backends hardcode a Unix host's /usr/bin/python3. Android
    # has neither that GNU/Linux interpreter nor an executable app-data ELF.
    if command in ("/usr/bin/python", "/usr/bin/python3"):
        target = prefix + "/bin/python3"
    elif "/" not in command:
        # Resolve from the child environment, not parent global PATH. This
        # catches pip build-isolation scripts living under HOME as well.
        path = shutil.which(command, path=env.get("PATH") or os.environ.get("PATH", ""))
        if path is None:
            return None
        target = os.path.abspath(path)
    else:
        target = os.path.abspath(command)

    # Do not reinterpret system or unrelated app executables. App-private
    # ELF and #! scripts go to Android's trusted system-shell bridge.
    files = os.path.dirname(prefix.rstrip("/"))
    if not (_under(target, prefix) or _under(target, home)
            or _under(target, files + "/tmp")):
        return None
    if not os.path.isfile(target):
        return None
    return [target, *argv[1:]]


def bridge_argv(args, *, prefix, home=None, env=None, shell="/system/bin/sh",
                bridge=None):
    """Return a new argv for a private child command, otherwise None."""
    prefix = os.path.normpath(os.fspath(prefix))
    home = os.path.normpath(os.fspath(home)) if home else os.path.dirname(prefix) + "/home"
    environment = env if env is not None else os.environ
    selected = _selected(args, prefix, home, environment)
    if selected is None:
        return None
    script = bridge or prefix + "/libexec/dsh-mobile/android-exec.sh"
    if not os.path.isfile(script):
        return None
    return [shell, script, *selected]


def install(*, prefix=None, shell="/system/bin/sh", bridge=None, force=False):
    """One-time activation, scoped to the embedded Android DSH Python only.

    force=True with an explicit prefix/shell is for offline Linux test fixtures.
    No Android secrets, command bodies, or private paths are logged.
    """
    global _PATCHED
    if _PATCHED:
        return True
    if not force and os.environ.get("DSH_ANDROID_STANDALONE") != "1":
        return False
    base = prefix or os.environ.get("TERMUX__PREFIX") or os.environ.get("PREFIX") or ""
    if not base or (not force and not _PREFIX.fullmatch(base)):
        return False
    base = os.path.normpath(base)
    bridge_script = bridge or base + "/libexec/dsh-mobile/android-exec.sh"
    if not os.path.isfile(bridge_script):
        return False
    original = subprocess.Popen.__init__

    def dsh_init(self, args, *positional, **kwargs):
        # Preserve all Popen overloads, stdin/stdout/stderr/cwd/pass_fds,
        # shell=True and explicit custom executable behavior.
        # Positional argument 2 is the optional executable= override.
        if (not kwargs.get("shell", False)
                and kwargs.get("executable") is None
                and (len(positional) < 2 or positional[1] is None)):
            environment = kwargs.get("env") or os.environ
            routed = bridge_argv(
                args, prefix=base, home=environment.get("HOME") or os.environ.get("HOME"),
                env=environment, shell=shell, bridge=bridge_script)
            if routed is not None:
                # A PEP517 backend can replace its entire environment; keep
                # just the minimum Android bridge variables for the new child.
                if kwargs.get("env") is not None:
                    environment = dict(kwargs["env"])
                    environment.setdefault("TERMUX__PREFIX", base)
                    environment.setdefault("PREFIX", base)
                    environment.setdefault("DSH_ANDROID_STANDALONE", "1")
                    kwargs["env"] = environment
                args = routed
        return original(self, args, *positional, **kwargs)

    subprocess.Popen.__init__ = dsh_init
    subprocess.Popen._dsh_android_wx_bridge = True
    _PATCHED = True
    return True


# Called by the .pth startup hook; this must be safe in pip isolated builds.
# Android app UID is the only production activation scope.
