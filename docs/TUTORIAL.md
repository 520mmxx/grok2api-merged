# Grok2API Merged 详细使用教程

> 从零开始，手把手教你部署和使用

---

## 📑 目录

1. [环境准备](#1-环境准备)
2. [Cloudflare 资源创建](#2-cloudflare-资源创建)
3. [项目配置](#3-项目配置)
4. [数据库迁移](#4-数据库迁移)
5. [部署上线](#5-部署上线)
6. [管理后台使用](#6-管理后台使用)
7. [Token 管理](#7-token-管理)
8. [代理池管理](#8-代理池管理)
9. [API 调用示例](#9-api-调用示例)
10. [常见问题](#10-常见问题)

---

## 1. 环境准备

### 1.1 安装 Node.js

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# macOS
brew install node

# 验证
node --version   # 需要 v18+
npm --version
```

### 1.2 安装 Wrangler CLI

```bash
npm install -g wrangler

# 验证
wrangler --version
```

### 1.3 登录 Cloudflare

```bash
wrangler login
# 会打开浏览器，授权后即可
```

---

## 2. Cloudflare 资源创建

### 2.1 创建 D1 数据库

```bash
wrangler d1 create grok2api
```

输出示例：
```
✅ Successfully created DB 'grok2api' in region APAC
Created database 'grok2api' (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
```

**⚠️ 记下返回的 database_id，后面要用！**

### 2.2 创建 KV 命名空间

```bash
wrangler kv:namespace create KV_CACHE
```

输出示例：
```
🌀 Creating namespace with title "grok2api-KV_CACHE"
✨ Success!
{ binding = "KV_CACHE", id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
```

**⚠️ 记下返回的 id，后面要用！**

---

## 3. 项目配置

### 3.1 编辑 wrangler.toml

打开 `wrangler.toml`，替换以下内容：

```toml
[[d1_databases]]
binding = "DB"
database_name = "grok2api"
database_id = "你的D1数据库ID"          # ← 替换这里
migrations_dir = "migrations"

[[kv_namespaces]]
binding = "KV_CACHE"
id = "你的KV命名空间ID"                 # ← 替换这里
```

### 3.2 配置代理池（可选）

在 `wrangler.toml` 的 `[vars]` 段中：

```toml
[vars]
# 代理列表，逗号分隔
PROXY_URLS = "http://1.2.3.4:8080,http://5.6.7.8:3128,socks5h://9.10.11.12:1080"

# 外部代理池 API（可选，返回单个代理URL）
PROXY_POOL_URL = "https://your-proxy-pool-api.com/get"

# 代理池刷新间隔（秒）
PROXY_POOL_INTERVAL = "300"
```

### 3.3 代理 URL 格式说明

| 格式 | 示例 | 说明 |
|------|------|------|
| HTTP | `http://ip:port` | HTTP 代理 |
| HTTPS | `https://ip:port` | HTTPS 代理 |
| SOCKS5 | `socks5://ip:port` | SOCKS5 代理 (自动转 socks5h) |
| SOCKS5H | `socks5h://ip:port` | SOCKS5H 代理 (DNS 通过代理解析) |

---

## 4. 数据库迁移

```bash
cd grok2api-merged

# 安装依赖
npm install

# 执行所有迁移（共6个）
wrangler d1 migrations apply DB --remote
```

迁移会创建以下表：
- `settings` - 配置
- `tokens` - SSO Token
- `api_keys` - API Key
- `api_key_usage_daily` - 每日配额
- `admin_sessions` - 管理会话
- `request_logs` - 请求日志
- `token_refresh_progress` - 刷新进度
- `kv_cache` - 缓存元数据
- **`proxy_pool`** - 🆕 代理池
- **`proxy_sso_bindings`** - 🆕 SSO-代理绑定

确认迁移成功：
```bash
wrangler d1 list
wrangler d1 info grok2api
```

---

## 5. 部署上线

```bash
# 部署到 Cloudflare Workers
wrangler deploy
```

输出示例：
```
✨ Successfully published grok2api (x.xx sec)
  https://grok2api.你的用户名.workers.dev
```

### 5.1 验证部署

```bash
# 健康检查
curl https://你的域名/health
```

返回：
```json
{
  "status": "healthy",
  "service": "Grok2API",
  "runtime": "cloudflare-workers",
  "proxy_pool": {
    "enabled": true,
    "total": 3,
    "healthy": 3
  }
}
```

---

## 6. 管理后台使用

### 6.1 登录

访问 `https://你的域名/login`

默认账号：
- 用户名: `admin`
- 密码: `admin`

**⚠️ 务必在配置中修改默认密码！**

### 6.2 管理后台页面

| 路径 | 功能 |
|------|------|
| `/admin/token` | Token 管理 |
| `/admin/config` | 配置管理 |
| `/admin/keys` | API Key 管理 |
| `/admin/cache` | 缓存管理 |
| `/admin/datacenter` | 数据中心 |

---

## 7. Token 管理

### 7.1 获取 SSO Token

1. 打开浏览器，访问 https://grok.com
2. 登录你的 Grok 账号
3. 打开浏览器开发者工具 (F12)
4. 切换到 Application (应用程序) 标签
5. 在左侧找到 Cookies → https://grok.com
6. 找到名为 `sso` 的 cookie，其值就是 SSO Token

### 7.2 添加 Token

在管理后台 `/admin/token`：

1. 选择 Token 类型 (`sso` 或 `ssoSuper`)
2. 粘贴 Token（支持批量，每行一个）
3. 点击「添加」

或者通过 API：
```bash
curl -X POST https://你的域名/api/tokens/add \
  -H "Authorization: Bearer 管理员会话Token" \
  -H "Content-Type: application/json" \
  -d '{
    "tokens": ["你的sso-token值"],
    "token_type": "sso"
  }'
```

### 7.3 测试 Token

在管理后台点击 Token 旁边的「测试」按钮，或：
```bash
curl -X POST https://你的域名/api/tokens/test \
  -H "Authorization: Bearer 会话Token" \
  -H "Content-Type: application/json" \
  -d '{"token": "你的token", "token_type": "sso"}'
```

---

## 8. 代理池管理 🆕

### 8.1 添加代理

**方法一：wrangler.toml 静态配置**
```toml
[vars]
PROXY_URLS = "http://ip1:8080,http://ip2:3128,socks5h://ip3:1080"
```
重新部署后自动生效。

**方法二：管理 API 动态添加**
```bash
# 添加单个代理
curl -X POST https://你的域名/api/v1/admin/proxies \
  -H "Authorization: Bearer 管理员会话Token" \
  -H "Content-Type: application/json" \
  -d '{"url": "http://192.168.1.100:8080"}'

# 批量添加
curl -X POST https://你的域名/api/v1/admin/proxies \
  -H "Authorization: Bearer 会话Token" \
  -H "Content-Type: application/json" \
  -d '{"urls": ["http://ip1:8080", "http://ip2:3128", "socks5h://ip3:1080"]}'
```

### 8.2 查看代理池状态

```bash
curl https://你的域名/api/v1/admin/proxies \
  -H "Authorization: Bearer 会话Token"
```

返回：
```json
{
  "success": true,
  "data": {
    "enabled": true,
    "proxies": [
      {
        "url": "http://192.168.1.100:8080",
        "healthy": true,
        "fail_count": 0,
        "total_requests": 156,
        "success_requests": 153,
        "success_rate": 98.08,
        "assigned_sso": ["abc123", "def456"],
        "assigned_sso_count": 2
      }
    ],
    "total": 3,
    "healthy": 3,
    "unhealthy": 0,
    "sso_assignments": {
      "sso-token-1": "http://192.168.1.100:8080",
      "sso-token-2": "http://192.168.1.101:3128"
    }
  }
}
```

### 8.3 手动绑定 SSO 到代理

```bash
curl -X POST https://你的域名/api/v1/admin/proxies/assign \
  -H "Authorization: Bearer 会话Token" \
  -H "Content-Type: application/json" \
  -d '{
    "sso": "你的sso-token值",
    "proxy_url": "http://192.168.1.100:8080"
  }'
```

### 8.4 测试代理可用性

```bash
curl -X POST https://你的域名/api/v1/admin/proxies/test \
  -H "Authorization: Bearer 会话Token" \
  -H "Content-Type: application/json" \
  -d '{"url": "http://192.168.1.100:8080"}'
```

### 8.5 重置代理健康状态

```bash
curl -X POST https://你的域名/api/v1/admin/proxies/health/reset \
  -H "Authorization: Bearer 会话Token"
```

### 8.6 删除代理

```bash
curl -X DELETE https://你的域名/api/v1/admin/proxies \
  -H "Authorization: Bearer 会话Token" \
  -H "Content-Type: application/json" \
  -d '{"url": "http://192.168.1.100:8080"}'
```

### 8.7 代理池工作原理

```
请求进来 → 选择 Token (SSO) → 查询该 SSO 绑定的代理
  │                                    │
  ├─ 已绑定且健康 → 使用该代理 ──────────┤
  │                                    │
  ├─ 已绑定但不健康 → 解绑，重新分配 ────┤
  │                                    │
  └─ 未绑定 → Round-Robin 选一个健康代理 → 自动绑定
                                         │
                                  请求 Grok API
                                         │
                                  ├─ 成功 → markSuccess()
                                  └─ 失败 → markFailure()
                                            │
                                     累计3次失败
                                            │
                                     标记为不健康
                                     解绑所有 SSO
```

---

## 9. API 调用示例

### 9.1 获取模型列表

```bash
curl https://你的域名/v1/models \
  -H "Authorization: Bearer 你的API-Key"
```

### 9.2 聊天补全（非流式）

```bash
curl https://你的域名/v1/chat/completions \
  -H "Authorization: Bearer 你的API-Key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4",
    "messages": [
      {"role": "user", "content": "你好，请介绍一下自己"}
    ],
    "stream": false
  }'
```

### 9.3 聊天补全（流式）

```bash
curl https://你的域名/v1/chat/completions \
  -H "Authorization: Bearer 你的API-Key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4",
    "messages": [
      {"role": "user", "content": "用 Python 写一个快速排序"}
    ],
    "stream": true
  }'
```

### 9.4 图片生成

```bash
curl https://你的域名/v1/images/generations \
  -H "Authorization: Bearer 你的API-Key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-imagine-1.0",
    "prompt": "一只可爱的猫咪在阳光下睡觉",
    "n": 2,
    "size": "1024x1024",
    "response_format": "url"
  }'
```

### 9.5 Python SDK 调用

```python
from openai import OpenAI

client = OpenAI(
    api_key="你的API-Key",
    base_url="https://你的域名/v1"
)

# 聊天
response = client.chat.completions.create(
    model="grok-4",
    messages=[{"role": "user", "content": "你好"}],
    stream=True
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")

# 图片生成
image = client.images.generate(
    model="grok-imagine-1.0",
    prompt="A beautiful sunset over mountains",
    n=1,
    response_format="url"
)
print(image.data[0].url)
```

### 9.6 Node.js 调用

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "你的API-Key",
  baseURL: "https://你的域名/v1",
});

const response = await client.chat.completions.create({
  model: "grok-4",
  messages: [{ role: "user", "content": "你好" }],
  stream: true,
});

for await (const chunk of response) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

---

## 10. 常见问题

### Q1: 部署后访问显示 500 错误
**A**: 检查 `wrangler.toml` 中 `database_id` 和 `id` 是否正确填写。

### Q2: 登录后看不到 Token
**A**: 确认已执行数据库迁移 `wrangler d1 migrations apply DB --remote`。

### Q3: 代理不生效
**A**: 检查代理 URL 格式是否正确，确认代理服务器可用（用「测试代理」功能验证）。

### Q4: Token 额度显示 -1
**A**: 表示尚未查询过额度，点击「刷新全部」或单个 Token 的「测试」按钮。

### Q5: 如何修改默认密码？
**A**: 在管理后台 `/admin/config` → 应用设置 → 修改管理员密码。

### Q6: 代理池状态在哪里看？
**A**: 访问 `/health` 查看概要，或调用 `GET /api/v1/admin/proxies` 查看详情。

### Q7: 支持哪些代理协议？
**A**: HTTP、HTTPS、SOCKS5、SOCKS5H。SOCKS5 会自动转换为 SOCKS5H（DNS 通过代理解析）。

### Q8: 如何设置自定义域名？
**A**: 在 Cloudflare Dashboard → Workers & Pages → 你的 Worker → Settings → Domains & Routes → Add Custom Domain。
