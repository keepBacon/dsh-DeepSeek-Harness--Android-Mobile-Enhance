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


def _selected(args, prefix, home, env, cwd=None):
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
    legacy = {
        "/usr/bin/python": "python3", "/usr/bin/python3": "python3",
        "/usr/bin/cc": "clang", "/usr/bin/gcc": "clang",
        "/usr/bin/c++": "clang++", "/usr/bin/g++": "clang++",
        "/usr/bin/clang": "clang", "/usr/bin/clang++": "clang++",
        # Termux sysconfig may preserve the original com.termux compile prefix
        # after its Python executable has been relocated into the DSH APK.
        "/data/data/com.termux/files/usr/bin/python": "python3",
        "/data/data/com.termux/files/usr/bin/python3": "python3",
        "/data/data/com.termux/files/usr/bin/clang": "clang",
        "/data/data/com.termux/files/usr/bin/clang++": "clang++",
    }
    if command in legacy:
        target = prefix + "/bin/" + legacy[command]
    elif "/" not in command:
        # Resolve from the child environment, not parent global PATH. Build
        # isolation often strips app-private directories from PATH entirely.
        path = shutil.which(command, path=env.get("PATH") or os.environ.get("PATH", ""))
        if path is None and command in {
            "python", "python3", "pip", "pip3", "clang", "clang++",
            "cc", "c++", "gcc", "g++", "make", "cmake", "ninja",
            "ld.lld", "pkg-config", "ar", "ranlib", "git",
        }:
            path = prefix + "/bin/" + command
        if path is None:
            return None
        target = os.path.abspath(path)
    elif os.path.isabs(command):
        target = command
    else:
        target = os.path.abspath(os.path.join(os.fspath(cwd or os.getcwd()), command))

    # Do not reinterpret system or unrelated app executables. App-private
    # ELF and #! scripts go to Android's trusted system-shell bridge.
    files = os.path.dirname(prefix.rstrip("/"))
    real = os.path.realpath(target)
    prefix_real = os.path.realpath(prefix)
    home_real = os.path.realpath(home)
    if not (_under(real, prefix_real) or _under(real, home_real)
            or _under(real, os.path.realpath(files + "/tmp"))):
        return None
    if not os.path.isfile(target):
        return None
    return [target, *argv[1:]]


def bridge_argv(args, *, prefix, home=None, env=None, cwd=None,
                shell="/system/bin/sh", bridge=None):
    """Return a new argv for a private child command, otherwise None."""
    prefix = os.path.normpath(os.fspath(prefix))
    home = os.path.normpath(os.fspath(home)) if home else os.path.dirname(prefix) + "/home"
    environment = env if env is not None else os.environ
    selected = _selected(args, prefix, home, environment, cwd=cwd)
    if selected is None:
        return None
    script = bridge or prefix + "/libexec/dsh-mobile/android-exec.sh"
    if not os.path.isfile(script):
        return None
    return [shell, script, *selected]


def configure_compilers(prefix, shell, bridge):
    """Supply linker-routed compiler variables to Python build backends.

    Do not override user-selected compiler flags or force build isolation off.
    A valid command line is not proof that native headers, memory and the
    Python extension ABI are available on the Android device.
    """
    for key, name, flags in (
        ("CC", "clang", ""),
        ("CXX", "clang++", ""),
        ("LDSHARED", "clang", " -shared"),
    ):
        native = prefix + "/bin/" + name
        if os.path.isfile(native):
            os.environ.setdefault(key, shell + " " + bridge + " " + native + flags)


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
                env=environment, cwd=kwargs.get("cwd"),
                shell=shell, bridge=bridge_script)
            if routed is not None:
                # A PEP517 backend can replace its entire environment; keep
                # just the minimum Android bridge variables for the new child.
                if kwargs.get("env") is not None:
                    environment = dict(kwargs["env"])
                    environment.setdefault("TERMUX__PREFIX", base)
                    environment.setdefault("PREFIX", base)
                    environment.setdefault("DSH_ANDROID_STANDALONE", "1")
                    # PEP517 hooks may provide a replacement env without
                    # Termux's relocation variables. Only restore the child
                    # loader path when absent; don't override caller values,
                    # credentials, or deliberately changed PYTHONPATH.
                    environment.setdefault(
                        "LD_LIBRARY_PATH",
                        os.environ.get("LD_LIBRARY_PATH") or base + "/lib")
                    for key in ("HOME", "TMPDIR", "BASH_ENV",
                                "TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE",
                                "TERMUX_EXEC__EXECVE_CALL__INTERCEPT"):
                        if key not in environment and os.environ.get(key):
                            environment[key] = os.environ[key]
                    kwargs["env"] = environment
                args = routed
        return original(self, args, *positional, **kwargs)

    subprocess.Popen.__init__ = dsh_init
    subprocess.Popen._dsh_android_wx_bridge = True
    configure_compilers(base, shell, bridge_script)
    _PATCHED = True
    return True


# Called by the .pth startup hook; this must be safe in pip isolated builds.
# Android app UID is the only production activation scope.
