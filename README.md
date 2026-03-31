# Grok2API Merged Edition

> Cloudflare Workers 一键部署 + D1/KV 自动绑定 + IP 地址池代理管理

---

## 📋 项目简介

**Grok2API Merged** 是基于 [grok2api](https://github.com/TQZHR/grok2api) 主干，合并了 [grok2api-pro](https://github.com/miuzhaii/grok2api-pro) 的 **IP 代理池管理** 功能后的增强版本。

提供 **OpenAI 兼容 API**，将 Grok (xAI) 的接口转换为标准的 `/v1/chat/completions`、`/v1/models`、`/v1/images/generations` 等端点，可直接对接任意 OpenAI SDK。

---

## 🏗️ 架构总览

```
┌─────────────────────────────────────────────────┐
│           Cloudflare Workers (Edge)              │
│  ┌───────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  Hono 路由  │  │ 代理池管理 │  │ Token 调度器  │  │
│  └─────┬─────┘  └────┬─────┘  └──────┬───────┘  │
│        │              │               │          │
│  ┌─────▼──────────────▼───────────────▼───────┐  │
│  │         Grok API 适配层 (conversation)       │  │
│  └─────────────────┬───────────────────────────┘  │
│                    │                              │
│  ┌─────────┐  ┌────▼─────┐  ┌──────────────┐    │
│  │ D1 数据库 │  │ KV 缓存   │  │ 代理池状态存储 │    │
│  └─────────┘  └──────────┘  └──────────────┘    │
└─────────────────────────────────────────────────┘
                      │
                      ▼
              ┌───────────────┐
              │   Grok.com    │
              │  (通过代理/直连) │
              └───────────────┘
```

---

## ✨ 核心功能

### 基础功能 (来自 grok2api)
- ✅ OpenAI 兼容 API (`/v1/chat/completions`, `/v1/models`, `/v1/images/generations`)
- ✅ 流式 / 非流式响应
- ✅ 图片生成 / 编辑 (legacy + experimental WebSocket 模式)
- ✅ 视频生成
- ✅ 多 Token 负载均衡 (sso / ssoSuper)
- ✅ API Key 管理 + 每日配额
- ✅ 管理后台 UI
- ✅ Cloudflare Workers 一键部署
- ✅ D1 数据库 + KV 缓存

### 新增功能 (来自 grok2api-pro → 代理池)
- 🆕 **IP 地址池代理管理** - 添加/删除/测试代理
- 🆕 **SSO 绑定** - 每个 Token 固定使用某个代理 (粘性会话)
- 🆕 **健康检查 / 失败熔断** - 连续 3 次失败自动摘除
- 🆕 **Round-Robin 调度** - 自动轮询分配代理
- 🆕 **D1 + KV 双持久化** - 数据不丢失
- 🆕 **代理池管理 API** - 7 个管理端点
- 🆕 **启动引导** - 环境变量自动填充代理

---

## 📁 项目结构

```
grok2api-merged/
├── src/                          # TypeScript 源码 (Cloudflare Workers)
│   ├── index.ts                  # Worker 入口 + 路由注册
│   ├── env.ts                    # 环境变量类型定义
│   ├── db.ts                     # D1 数据库工具
│   ├── auth.ts                   # 认证中间件
│   ├── settings.ts               # 配置管理 (D1 读写)
│   ├── proxy/                    # 🆕 代理池模块
│   │   └── pool.ts               # 🆕 代理池核心 (381行)
│   ├── grok/                     # Grok API 适配
│   │   ├── conversation.ts       # 请求构建 + 代理路由
│   │   ├── processor.ts          # 响应处理 (NDJSON→SSE)
│   │   ├── headers.ts            # 动态请求头
│   │   ├── models.ts             # 模型目录 (15个模型)
│   │   ├── rateLimits.ts         # 额度检查
│   │   ├── upload.ts             # 图片上传
│   │   ├── create.ts             # 视频 Post 创建
│   │   └── imagineExperimental.ts # WebSocket 图片生成
│   ├── routes/                   # API 路由
│   │   ├── openai.ts             # OpenAI 兼容端点
│   │   ├── media.ts              # 媒体代理
│   │   └── admin.ts              # 管理 API (含代理池管理)
│   ├── repo/                     # 数据访问层
│   │   ├── tokens.ts             # Token CRUD
│   │   ├── apiKeys.ts            # API Key CRUD
│   │   ├── apiKeyUsage.ts        # 每日配额
│   │   ├── adminSessions.ts      # 管理会话
│   │   ├── cache.ts              # KV 缓存元数据
│   │   ├── logs.ts               # 请求日志
│   │   └── refreshProgress.ts    # 刷新进度
│   ├── kv/                       # KV 清理
│   │   └── cleanup.ts
│   └── utils/                    # 工具函数
│       ├── base64.ts
│       ├── crypto.ts
│       └── time.ts
├── app/                          # Python 版本 (FastAPI，备用)
│   ├── api/
│   ├── core/
│   └── static/                   # 管理后台 UI 静态资源
├── migrations/                   # D1 数据库迁移
│   ├── 0001_init.sql             # 初始表结构
│   ├── 0002_r2_cache.sql
│   ├── 0003_kv_cache.sql
│   ├── 0004_settings_sections.sql
│   ├── 0005_api_key_quotas.sql
│   └── 0006_proxy_pool.sql       # 🆕 代理池表
├── wrangler.toml                 # Workers 配置
├── package.json                  # Node.js 依赖
├── tsconfig.json                 # TypeScript 配置
├── config.defaults.toml          # 默认配置
└── pyproject.toml                # Python 依赖 (备用)
```

---

## 🔧 环境变量

### wrangler.toml 配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CACHE_RESET_TZ_OFFSET_MINUTES` | 时区偏移 (分钟) | `480` (UTC+8) |
| `KV_CACHE_MAX_BYTES` | KV 值最大字节数 | `26214400` (25MB) |
| `KV_CLEANUP_BATCH` | 每日清理批次大小 | `200` |
| `PROXY_URLS` | 🆕 代理 URL 列表 (逗号分隔) | `""` |
| `PROXY_POOL_URL` | 🆕 外部代理池 API 地址 | `""` |
| `PROXY_POOL_INTERVAL` | 🆕 代理池刷新间隔 (秒) | `300` |

### D1 数据库表

| 表名 | 用途 |
|------|------|
| `settings` | 全局配置 (JSON) |
| `tokens` | SSO Token 管理 |
| `api_keys` | API Key 管理 |
| `api_key_usage_daily` | 每日配额统计 |
| `admin_sessions` | 管理员会话 |
| `request_logs` | 请求日志 |
| `token_refresh_progress` | Token 刷新进度 |
| `kv_cache` | KV 缓存元数据 |
| `proxy_pool` | 🆕 代理池 |
| `proxy_sso_bindings` | 🆕 SSO-代理绑定 |

---

## 🚀 快速部署

### 前置条件
- [Cloudflare](https://dash.cloudflare.com) 账号
- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

### 一键部署步骤

```bash
# 1. 进入项目目录
cd grok2api-merged

# 2. 安装依赖
npm install

# 3. 登录 Cloudflare
wrangler login

# 4. 创建 D1 数据库
wrangler d1 create grok2api
# 记下返回的 database_id

# 5. 创建 KV 命名空间
wrangler kv:namespace create KV_CACHE
# 记下返回的 id

# 6. 编辑 wrangler.toml，填入 database_id 和 KV id
# database_id = "你的D1数据库ID"
# id = "你的KV命名空间ID"

# 7. 执行数据库迁移 (包含代理池表)
wrangler d1 migrations apply DB --remote

# 8. 部署
wrangler deploy
```

部署完成后会得到一个 `*.workers.dev` 域名，访问 `/login` 进入管理后台。

---

## 🔌 API 端点

### OpenAI 兼容端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/models` | GET | 列出所有可用模型 |
| `/v1/models/{model_id}` | GET | 获取模型详情 |
| `/v1/chat/completions` | POST | 聊天补全 (支持流式) |
| `/v1/images/generations` | POST | 图片生成 |
| `/v1/images/edits` | POST | 图片编辑 |
| `/v1/images/method` | GET | 获取图片生成方法 |

### 管理端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/login` | POST | 管理员登录 |
| `/api/settings` | GET/POST | 配置读写 |
| `/api/tokens` | GET | Token 列表 |
| `/api/tokens/add` | POST | 添加 Token |
| `/api/tokens/delete` | POST | 删除 Token |
| `/api/tokens/test` | POST | 测试 Token |
| `/api/tokens/refresh-all` | POST | 刷新所有 Token |
| `/api/stats` | GET | 统计数据 |
| `/api/logs` | GET | 请求日志 |
| `/api/v1/admin/keys` | GET/POST | API Key 管理 |
| `/api/v1/admin/config` | GET/POST | 高级配置 |

### 🆕 代理池管理端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/admin/proxies` | GET | 获取代理池列表 |
| `/api/v1/admin/proxies` | POST | 添加代理 (单个/批量) |
| `/api/v1/admin/proxies` | DELETE | 删除代理 |
| `/api/v1/admin/proxies/assign` | POST | 绑定 SSO 到代理 |
| `/api/v1/admin/proxies/unassign` | POST | 解绑 SSO |
| `/api/v1/admin/proxies/health/reset` | POST | 重置代理健康状态 |
| `/api/v1/admin/proxies/test` | POST | 测试代理可用性 |
| `/api/v1/admin/proxies/clear` | POST | 清空代理池 |

---

## 🤖 可用模型

| 模型 ID | 类型 | 说明 |
|---------|------|------|
| `grok-3` | 文本 | Grok 3 基础模型 |
| `grok-3-mini` | 文本 | Grok 3 Mini |
| `grok-3-thinking` | 文本 | Grok 3 思维链 |
| `grok-4` | 文本 | Grok 4 基础模型 |
| `grok-4-mini` | 文本 | Grok 4 Mini |
| `grok-4-thinking` | 文本 | Grok 4 思维链 |
| `grok-4-heavy` | 文本 | Grok 4 Heavy (需 Super Token) |
| `grok-4.1-mini` | 文本 | Grok 4.1 Mini |
| `grok-4.1-fast` | 文本 | Grok 4.1 Fast |
| `grok-4.1-expert` | 文本 | Grok 4.1 Expert |
| `grok-4.1-thinking` | 文本 | Grok 4.1 思维链 |
| `grok-4.20-beta` | 文本 | Grok 4.20 Beta |
| `grok-imagine-1.0` | 图片 | 图片生成 |
| `grok-imagine-1.0-edit` | 图片 | 图片编辑 |
| `grok-imagine-1.0-video` | 视频 | 视频生成 |

---

## 📜 协议说明

本项目采用 **MIT License** 开源协议。

### 来源声明
- **主干**: [TQZHR/grok2api](https://github.com/TQZHR/grok2api) - MIT License
- **代理池功能**: [miuzhaii/grok2api-pro](https://github.com/miuzhaii/grok2api-pro) - MIT License
- **合并版本**: 保留两个项目的 MIT License

### 免责声明
1. 本项目仅供学习和个人使用
2. 使用本项目即代表你同意自行承担一切风险
3. 请遵守 Grok/xAI 的服务条款
4. 不得用于任何违法违规用途
5. 作者不对任何滥用行为负责

### 第三方依赖
- [Hono](https://hono.dev/) - MIT License
- [Cloudflare Workers Types](https://developers.cloudflare.com/workers/) - MIT/Apache-2.0
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) - MIT/Apache-2.0

---

## 🔗 相关链接

- 原项目: https://github.com/TQZHR/grok2api
- 代理池来源: https://github.com/miuzhaii/grok2api-pro
- Cloudflare Workers 文档: https://developers.cloudflare.com/workers/
- D1 数据库文档: https://developers.cloudflare.com/d1/
- KV 文档: https://developers.cloudflare.com/kv/
