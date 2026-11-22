# DSH Today Mobile (experimental)

手机端直接通过 Today 网页手机号 / SMS 验证码登录，并将模型注册到 DSH。

## 当前进度（代码已实现，真机未验收）
- DSH 设置 → Today AI：手机号、验证码、登录、退出登录。
- 首次登录后将 session cookie 写入 DSH credentials 服务；前端不接收 cookie/JWT。
- 通过 Today /api/token 校验会话；复用原 Today 连接器进行模型对话。
- 验证码请求每 60 秒限一次，单次发送后验证码最多尝试 5 次。
- GitHub Actions 执行本地无网络契约测试。

## 安装
目前尚未发布到 npm。此目录是独立 DSH bundle 包，可以复制到 Android DSH 插件可访问的本地目录，然后通过 DSH 插件管理器的“本地安装”功能选择该目录。由于各个 Android DSH 构建版本的本地安装 UI 不完全一致，暂不提供未经验证的命令。
不要把整个 Android DSH 仓库当成单个插件导入。

启用后，进入 DSH 设置里的 **Today AI**，填写带国际区号的手机号（例如 +86...），获取 SMS 验证码并登录。Token 不需要手工配置。

## 兼容限制
- 需要 DSH 提供 `llm`、`credentials`、`connection`、`webServer` 服务以及客户端 `settings.section` 插槽。
- 当前 Today OTP endpoint / cookie 响应格式依据 2026-11-18 的协议调查，未在 Android 真机验证；若服务端变更，将显示错误而不会冒充登录成功。
- Today 模型仍采用基于文本的工具调用模拟，**不等同于原生工具调用**；也无真正流式响应或独立上游会话隔离。
- Today 上游有可能限制第三方客户端；使用前需确认当前服务条款。
- 存储依赖 DSH credentials 提供的安全性，不将账号 Cookie 写入插件配置、Git 仓库或前端 LocalStorage。
- 本目录的原始模型适配器 `lib/adapter.js` 复用自 [wzs39/today-dsh-connector](https://github.com/wzs39/today-dsh-connector)，原项目标注 MIT。
- **不要与原 `dsh-today-connector` 同时启用同名 `today` 模型提供方**。

## 测试
```bash
node --test plugins/dsh-today-mobile/test/*.test.mjs
node --check plugins/dsh-today-mobile/lib/auth.js
node --check plugins/dsh-today-mobile/lib/auth-rpc.js
node --check plugins/dsh-today-mobile/lib/client.js
```

真机验收：安装 → 设置入口出现 → OTP 发出 → 会话 Cookie 在凭据中心持久化 → 重启仍已登录 → Today 模型对话 → 额度变化 → 退出后不可继续调用。

## 安全设计
所有登录操作通过 DSH 自带 `connection.requestRejection` 认证的同源 RPC 服务执行；不提供不受保护的本地 HTTP 端口，不把 Cookie/JWT 传给 WebView；保留 DSH 既有的会话与权限约束。
