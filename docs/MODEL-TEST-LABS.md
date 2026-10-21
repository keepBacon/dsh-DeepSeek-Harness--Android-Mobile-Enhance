# DSH 模型测试实验室 V1

## 独立于数据库任务

数据库 PR #28 暂停；记录见 [DATABASE-PAUSED.md](DATABASE-PAUSED.md)。本实验室不访问该数据库。

## 3D 场景

路径：**应用设置 → 模型测试实验室 → 3D 空间模拟实验室**。

- 坐标系：右手系，+X 右、+Y 上、+Z 前；米、角度制。Yaw=0 正前（+Z），Yaw=90 朝 +X；Pitch 正向上。
- 玩家位置与朝向、摄像机相对位置/朝向/FOV、准心二维规范坐标、射线起点/方向/交点。
- 头、躯干、左右手臂、左右腿的局部坐标、世界坐标、前向量。
- 物品/地块采用轴向包围盒，可显示相机/玩家到物体距离、朝向角与射线命中。
- 以固定秒数模拟移动/转向；可编辑场景 JSON，输出可直接发给模型的模型观察 JSON。操作不连接真实游戏，也不会自动读取玩家数据。
- 核心模块：`app/src/main/assets/labs/spatial-core.js`，可在 Node 下不依赖浏览器进行回归：`node scripts/test-spatial-lab.cjs`。
- 离线独立 WebView 禁用 Android JavascriptInterface，JS 没有文件/网络权限调用桥。当前实现不是物理引擎：无动画骨骼、重力、导航网格、物理碰撞响应或真实游戏 API。
- 视窗渲染按固定 960×600 的投影进行；JSON 中的准心射线目前采用固定 16:9 横纵比，属于 V1 已知限制（后续需通过 viewport 统一）。

## 真正的 Luau CLI

入口：**应用设置 → 模型测试实验室 → Luau 代码测试**。

`LuauTestRunner.kt` 只调用应用私有运行时 `usr/bin/luau`，不以 Lua 5.x 或 WebView JavaScript 替代。当前仓库默认快照并未保证包含此二进制；未找到时明确报错，绝不标记测试成功。

集成计划：
1. 在 Android/Termux 对应架构的构建环境从 [Luau 官方源码](https://github.com/luau-lang/luau) 构建 `luau` CLI，验证与设备 ABI/NDK/Termux libc 兼容。
2. 将可执行文件及其动态依赖加入构建脚本的暂存快照（`stage/usr/bin/luau`），加入 smoke：`luau --version` 并运行独立测试脚本。构建过程应当固定源码版本/校验值，不能拉取未经确认的可执行文件。
3. 在设备上进行 LuaU 语法、型别检查与实际运行验证。注意 Roblox 服务（Workspace、Players、Instance 等）不属于独立 CLI，需额外模拟 API；当前不提供。
4. 后续接入模型辅助生成/理解场景可使用上述统一观察 JSON，不自动执行未经用户确认的游戏脚本。

**安全约束**：当前 Luau CLI 入口只适用于可信测试脚本；超时与输出大小限制不是进程沙箱，不可对任意不可信代码声称安全。执行前需额外增加隔离/资源配额才能开放任意来源的脚本。
