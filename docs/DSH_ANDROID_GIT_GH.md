# Git + GitHub CLI in DSH Android ARM64

This runtime bundles the **Termux aarch64** packages `git`, `gh`, `openssh`, and
`ca-certificates` from the checksum-verified APT package index.

It does **not** embed any GitHub credential or log in automatically. The
Android app user owns its own `~/.gitconfig`, `~/.ssh`, and
`~/.config/gh` (the GitHub CLI configuration directory is created with mode
0700). Git HTTPS certificate verification remains enabled.

## Device acceptance checklist

In DSH's Bash tool or terminal, first run read-only checks:

```sh
git --version
gh --version
git --exec-path
gh auth status
```

The last command may report "not logged in"; that is **not** a binary failure.

Then test local Git without affecting any existing repository:

```sh
mkdir -p "$HOME/git-gh-smoke"
cd "$HOME/git-gh-smoke"
git init
git -c user.name='DSH Test' -c user.email='dsh-test@example.invalid' commit --allow-empty -m 'Android local Git smoke'
git log -1 --format='%h %s'
git status --short
```

Remove this temporary directory only if you no longer need it. Never clear
the DSH app's main data directory to repair Git.

For HTTPS transport / nested Git subprocess checks (requires network access):

```sh
GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/cli/cli.git HEAD
```

A printed commit SHA means TLS, the git-remote-https helper and spawning its
child succeeded. `git --version` alone does **not** establish that.

For GitHub CLI API access without credentials:

```sh
gh api rate_limit --jq .resources.core.limit
```

A 403 rate-limit error may simply be GitHub API throttling. A connection
or certificate error is a separate failure.

## Authentication

In a genuinely interactive DSH terminal you can use:

```sh
gh auth login --hostname github.com --git-protocol https --web
gh auth status
```

The `--web` flow may display a device code and ask you to open a web page.
Follow it locally; **never paste the access token into an AI chat**.

For a repository you own:

```sh
gh repo view OWNER/REPOSITORY
gh pr list -R OWNER/REPOSITORY
gh run list -R OWNER/REPOSITORY
```

The model's noninteractive tool environment has `GIT_TERMINAL_PROMPT=0` so
it does not hang waiting for credentials. Do not set `GIT_SSL_NO_VERIFY=1`,
`http.sslVerify=false`, `safe.directory=*`, or put a token in a Git URL.

## Android-specific troubleshooting

Android prohibits directly executing most app-private files. DSH invokes the
embedded ARM64 binaries through its system-shell/linker bridge. Child tools,
including Git's `git-remote-https`, require **separate device verification**.
This repository's GitHub Actions preflight validates file existence, SHA-256,
architecture and metadata, not a real Android execution.

If `git --version` succeeds but `git ls-remote` fails, capture the **full
exit code and stderr** (redact any secrets); report it as a Git child-exec
failure, not as a GitHub login issue. Likewise, report `gh api` failures
separately from Git transport failures.

No automatic credential changes, profile reset or TLS bypass are authorized.
