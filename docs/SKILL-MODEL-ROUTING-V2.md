# Skill 模型自动使用增强 V2 — 开发记录

## 目标
提高 DSH 模型发现、选择、读取和正确执行已安装 Skills 的成功率；优先提升模型能力，不以安装管理或 UI 美化为主。**当前仅完成独立开发分支和架构基线，不能声称自动触发已实现。**

## 现有接口
- `SkillManager.listJson()`：列出本地 Skills、frontmatter 中的 `user-invocable` 和 `disable-model-invocation` 状态；该列表不代表模型运行时实际加载。
- `SkillManager.importUri()`：ZIP/MD 安装；应维持此路径的文件安全防线。
- `scripts/android-runtime-patch.mjs`：运行时补丁入口；未来在核对实际 DSH Skill provider 版本后才能插入最小 hook。
- 运行时必须区分 `installed` / `eligible` / `discovered` / `loaded` / `invoked` / `completed`；禁止用“已安装”冒充“已使用”。

## 实施顺序
1. 从真实 DSH Skill provider/工具调用处梳理发现与读取链路，记录版本、调用条件与可观测事件。先做只读链路验证。
2. 模型任务到 Skill 元数据的相关性检索（名称、描述、适用范围），排除 `disable-model-invocation: true` 及未获授权 Skill。无命中时保持正常模型流程。
3. 选择后按需读取 `SKILL.md` 和显式关联资源，在上下文预算内分层加载；不得预加载全部脚本/资源。
4. 对工具执行的真实证据进行只读追踪：注册、加载、调用、结果和失败分类。遇到缺依赖不能虚构完成。
5. 加入匹配/误触发、禁用/启用、外部内容注入、上下文开销和多 Skill 协作测试。

## 安全及项目隔离
- Skill 是第三方可编辑指令，不能超越系统指令、用户授权、沙箱及工具权限。
- 数据库 PR #28 按用户要求继续暂停。
- 3D PR #29 和安全模式 PR #31 独立；本分支禁止触碰安全模式、3D 及数据库源码。
- 不修改 `main`；需要完成 CI 和 Android 真实 Skill provider 集成测试才允许合并。
