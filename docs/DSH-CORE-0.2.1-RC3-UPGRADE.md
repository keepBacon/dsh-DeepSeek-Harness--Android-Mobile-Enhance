# DSH core upgrade: 0.1.5-rc.2 → 0.2.1-rc.3

Upgrade branch: `feature/dsh-core-0.2.1-rc3`. Upstream official source: `deepseek-ai/deepseek-harness`, tag `dsh-v0.2.1-rc.3`, commit `1f81c047fc48fa190a683e469daa699857e9afe8` (2026-10-23). This is a release candidate; upgrading the version lock alone does **not** demonstrate successful Android runtime installation.

## Upgrade contract

1. All Termux build entrypoints default to `0.2.1-rc.3` and the release-family manifest uses that exact version.
2. The published Cordis vendor family remains pinned until the full npm dependency graph and singleton Cordis validation pass. Do **not** bypass `dsh-runtime-family.mjs` checks to force an install.
3. The Android-specific patcher is run against the *published* runtime. Upstream source anchors can change; failure is a migration blocker until corrected. Avoid treating the old 0.1.5 package-shape assertions as proof of 0.2 compatibility.
4. App user data, plugin files, session files, DB indexes and Skills must remain intact. No automatic data reset or destructive reinstall.
5. A debug APK compiled with a CI placeholder runtime is **not** a full target runtime smoke test.

## Gates

- [ ] GitHub Actions static, Android patch and full published runtime graph checks
- [ ] Android/Termux full `bash build-termux.sh` with `DSH_REFRESH_RUNTIME=1`, then artifact SHA-256
- [ ] Actual embedded `dsh web` startup, default profile and plugin inventory
- [ ] Existing user sessions, MCP tools, Skill loading and Code Engine edits unchanged after upgrade
- [ ] Database backup/restore, index rebuild and application restart on target device
- [ ] Rollback plan: preserve the previous installed APK/runtime and user data backup

The branch remains independent of `main` until the above compatibility gates have credible evidence. A failing check should be fixed or recorded as a blocker, **never** disabled or silently converted to a pass.
