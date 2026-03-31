# 部署检查清单 (Deploy Checklist)

> 按顺序执行，每完成一步打 ✅

---

## 准备阶段

- [ ] 已注册 Cloudflare 账号
- [ ] 已安装 Node.js 18+
- [ ] 已安装 Wrangler CLI (`npm install -g wrangler`)
- [ ] 已登录 Wrangler (`wrangler login`)

## 资源创建

- [ ] 已创建 D1 数据库 (`wrangler d1 create grok2api`)
  - Database ID: `________________________`
- [ ] 已创建 KV 命名空间 (`wrangler kv:namespace create KV_CACHE`)
  - KV ID: `________________________`

## 项目配置

- [ ] 已编辑 `wrangler.toml` → 填入 `database_id`
- [ ] 已编辑 `wrangler.toml` → 填入 KV `id`
- [ ] (可选) 已配置 `PROXY_URLS` 代理列表
- [ ] (可选) 已配置 `PROXY_POOL_URL` 动态代理池地址
- [ ] 已安装依赖 (`npm install`)

## 数据库迁移

- [ ] 已执行迁移 (`wrangler d1 migrations apply DB --remote`)
- [ ] 验证表已创建 (`wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='table'"`)

## 部署上线

- [ ] 已执行部署 (`wrangler deploy`)
- [ ] 部署域名: `https://________________________.workers.dev`
- [ ] 健康检查通过 (`curl /health` 返回 "healthy")

## 初始化配置

- [ ] 已登录管理后台 (`/login`, 默认 admin/admin)
- [ ] 已修改默认密码 (`/admin/config`)
- [ ] 已添加 SSO Token (`/admin/token`)
- [ ] Token 测试通过
- [ ] (可选) 已添加代理到代理池
- [ ] (可选) 代理测试通过
- [ ] (可选) 已创建 API Key (`/admin/keys`)

## 验证

- [ ] 调用 `/v1/models` 成功返回模型列表
- [ ] 调用 `/v1/chat/completions` 成功返回对话
- [ ] (可选) 调用 `/v1/images/generations` 成功生成图片
- [ ] (可选) 流式响应正常工作
- [ ] (可选) 代理池管理 API 正常工作

---

## 快速命令参考

```bash
# 创建资源
wrangler d1 create grok2api
wrangler kv:namespace create KV_CACHE

# 迁移
wrangler d1 migrations apply DB --remote

# 部署
wrangler deploy

# 查看日志
wrangler tail

# 本地开发
wrangler dev

# 查看数据库
wrangler d1 execute DB --remote --command "SELECT * FROM tokens"
```

## 环境变量速查

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CACHE_RESET_TZ_OFFSET_MINUTES` | 时区偏移 | `480` |
| `KV_CACHE_MAX_BYTES` | KV 最大值 | `26214400` |
| `KV_CLEANUP_BATCH` | 清理批次 | `200` |
| `PROXY_URLS` | 代理列表 | `""` |
| `PROXY_POOL_URL` | 动态池地址 | `""` |
| `PROXY_POOL_INTERVAL` | 池刷新间隔(秒) | `300` |
