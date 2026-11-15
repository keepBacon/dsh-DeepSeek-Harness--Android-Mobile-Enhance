# DSH Android ARM64 — ripgrep, fd and fzf

These search tools are bundled from checksum-verified Termux aarch64 packages:

- `rg` (ripgrep): fast content search with `--glob` and `--files`.
- `fd`: file and directory finder with ignore rules.
- `fzf`: fuzzy selector; **interactive use requires a real PTY**.

DSH's Android model Bash resolves missing shell commands through its system
shell/linker bridge, rather than directly executing binaries inside the
application's private writable directory. Commands can also be invoked
through the MCP `command_run` entrypoint using argv arguments.

## Read-only device acceptance

```sh
rg --version
fd --version
fzf --version
rg --files "$HOME" | head -n 5
fd --type f . "$HOME" | head -n 5
printf 'one\ntwo\nthree\n' | fzf --filter=tw
```

For an interactive shell **with a usable PTY**:

```sh
fd --type f . "$HOME" | fzf --height 40% --layout reverse
```

In a noninteractive model command without a TTY, prefer `fzf --filter`
(or `rg` / `fd`) rather than expecting an interactive screen.
The Bash keybindings and completion scripts are bundled under
`$PREFIX/share/fzf/`; they are **not auto-sourced** so normal Host start
and noninteractive shell tasks do not incur extra startup overhead.

## Safety and performance

`rg` and `fd` respect ignore rules by default. Use scoped paths and `rg -g`
glob restrictions for large projects. Avoid running `rg --hidden --no-ignore`
over all of Android storage, or an unbounded `fd` traversal of `node_modules`.

If a tool prints `Permission denied`, capture its command, exit code and
stderr and compare that against the existing DSH Android ELF bridge.
Do not disable SELinux or blindly add app-private executables ahead of the
Android system commands in `PATH`.

CI validates the Termux package closure, ARM64 ELF architecture, fzf's
shell scripts, and the signed runtime archive. **Interactive fzf rendering,
terminal resize, cancellation, and Android file permission behavior still
require a device PTY test.**
