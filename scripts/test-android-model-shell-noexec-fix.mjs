#!/usr/bin/env node
// Guard the production Android model Shell fix against silent patch omissions.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8')
const bridge = read('scripts/dsh-android-exec.sh')
const bashEnv = read('scripts/dsh-android-bash-env.sh')
const builder = read('scripts/ci-assemble-github-runtime.py')
const embed = read('scripts/embed-termux-tools.sh')
const patch = read('scripts/android-runtime-patch.mjs')
const engine = read('app/src/main/java/com/dshmobile/shell/EngineManager.kt')
assert.match(bridge, /PATH=\/system\/bin:\/system\/xbin/)
assert.ok(bridge.indexOf('PATH=/system/bin:/system/xbin') < bridge.indexOf('magic='), 'clean bridge PATH before command substitution')
assert.match(bashEnv, /command_not_found_handle\(\)/)
assert.match(bashEnv, /PATH=\/system\/bin:\/system\/xbin/)
assert.match(bashEnv, /DSH_WRAPPER_COMMAND="\$_dsh_name" DSH_TERMUX_INNER=1/)
assert.match(bashEnv, /_dsh_mobile_dispatch "\$_dsh_cmd" "\$@"/)
assert.match(bashEnv, /\/system\/bin\/sh "\$_dsh_mobile_prefix\/libexec\/dsh\/termux-wrapper"/)
assert.match(bashEnv, /\$_dsh_cmd" = node/)
assert.match(bashEnv, /\$_dsh_mobile_prefix\/bin\/node" "\$@"/)
assert.match(bashEnv, /\/system\/bin\/sh "\$_dsh_mobile_prefix\/libexec\/dsh-mobile\/android-exec\.sh"/)
assert.match(bashEnv, /embedded Node\.js executable missing/)
// Model bash must expose builtin-like shell functions so command -v works
// even though Android's noexec app-private usr/bin is deliberately off PATH.
for (const command of ['node', 'npm', 'npx', 'pnpm', 'pnpx']) {
  assert.ok(bashEnv.includes(command + '() {'), command + ' model Bash function missing')
}
assert.match(bashEnv, /lib\/node_modules\/npm\/bin\/npm-cli\.js/)
assert.match(bashEnv, /lib\/node_modules\/npm\/bin\/npx-cli\.js/)
assert.match(bashEnv, /lib\/node_modules\/pnpm\/bin\/pnpm\.cjs/)
assert.match(bashEnv, /pnpm dlx "\$@"/)
assert.match(bashEnv, /dsh-android-plugin-git-spawn\.cjs/)
assert.match(bashEnv, /NODE_OPTIONS="\$\{NODE_OPTIONS:\+\$NODE_OPTIONS \}--require=\$_dsh_git_preload"/)
assert.match(bashEnv, /if \[ -f "\$_dsh_git_preload" \]/)
assert.match(bashEnv, /case " \$\{NODE_OPTIONS:-\} " in/)
assert.match(bashEnv, /Shared Host environment already enabled the adapter/)
assert.match(builder, /legacy_npm = stage \/ "usr\/lib\/node_modules\/npm"/)
assert.match(builder, /shutil\.rmtree\(legacy_npm\)/)
assert.match(builder, /"nodejs", "npm"/)
assert.match(builder, /name == "npm"/)
assert.match(builder, /npm-cli\.js", "npx-cli\.js"/)
assert.ok(
  bashEnv.indexOf('$_dsh_cmd" = node') < bashEnv.indexOf('libexec/dsh/wrappers/$_dsh_cmd'),
  'Node must route directly before relying on a generic wrapper symlink'
)
assert.match(embed, /DSH_WRAPPER_COMMAND:-\$\{0##\*\/\}/)
assert.match(builder, /"dsh-android-bash-env.sh": "android-bash-env.sh"/)
assert.match(builder, /@deepseek-ai\/dsh-terminal-bash,@deepseek-ai\/dsh-sandbox-local,@deepseek-ai\/dsh-bash-local/)
// The 0.2 upgrade replaces the seed's entire DSH dependency tree with fresh
// published modules. Skipping subprocess-local here drops Android containment
// and executable spawning support even when all older tests pass.
assert.match(builder, /@deepseek-ai\/dsh-bash-local,@deepseek-ai\/dsh-subprocess-local/)
assert.match(builder, /node-addon-require-builtin,@deepseek-ai\/node-addon-system/)
assert.match(builder, /install_release\(stage, workspace, args\.repo\)/)
assert.match(builder, /args\.repo \/ "runtime-release-family\.json"/)
assert.match(builder, /args\.repo \/ "scripts\/dsh-release-family-lock\.json"/)
assert.match(patch, /DSH_COMPAT_SEED_SUBPROCESS_ONLY === "1"/)
assert.ok(!patch.includes('Boolean(process.env.DSH_COMPAT_ONLY_PACKAGES)'),
  'package selection must not suppress fresh-subprocess Android compatibility')
assert.match(patch, /DSH Android compat: model Bash environment without preload/)
assert.match(patch, /LD_PRELOAD: undefined/)
assert.match(patch, /BASH_ENV: \(process\.env\.TERMUX__PREFIX/)
assert.match(patch, /const seam = \/this/)
assert.match(engine, /"PATH" to \("\/system\/bin:" \+ usrDir\.absolutePath/)
assert.match(engine, /env\["NODE_OPTIONS"\] = "--require=" \+ pluginGitPreload\.absolutePath/)
assert.match(engine, /Shared engineEnv already preloads the child-process adapter/)
assert.match(engine, /"npm_config_script_shell" to "\/system\/bin\/sh"/)
assert.match(engine, /"npm_config_cache" to File\(nodeCacheDir, "npm"\)/)
assert.match(engine, /"PNPM_HOME" to File\(homeDir, "\.local\/share\/pnpm"\)/)
assert.ok(!engine.includes('val existing = env["NODE_OPTIONS"].orEmpty().trim()'), 'duplicate plugin adapter preload detected')
// Both fresh-install staging and post-install health need a complete Node
// command set; partial npm/pnpm installations cannot be marked healthy.
for (const relative of [
  'bin/npm', 'bin/npx', 'bin/pnpm',
  'lib/node_modules/npm/bin/npm-cli.js',
  'lib/node_modules/npm/bin/npx-cli.js'
]) {
  assert.ok(engine.includes('"' + relative + '"'), 'runtime health entry missing: ' + relative)
}
assert.match(engine, /pnpm\.cjs", "pnpm\.mjs", "pnpm\.js"/)
assert.ok(!bashEnv.includes('eval '))
console.log('[DSH] Android Bash noexec-safe PATH, child preload isolation, staged env and dispatch: OK')
