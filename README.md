# cloudflare-docker-proxy

> ### ⚠️ **Important Notice**
> <span style="color:#d73a49;font-weight:bold">Docker Hub is rate-limiting Cloudflare Worker IPs, causing frequent <code>429</code> errors.</span>  
> <span style="color:#d73a49;font-weight:bold">This project is currently NOT recommended for production use.</span>


Due to the current instability, this project is not recommended for production use.
We will provide updates as soon as more information becomes available.


![deploy](https://github.com/ciiiii/cloudflare-docker-proxy/actions/workflows/deploy.yaml/badge.svg)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ciiiii/cloudflare-docker-proxy)

> If you're looking for proxy for helm, maybe you can try [cloudflare-helm-proxy](https://github.com/ciiiii/cloudflare-helm-proxy).

## Deploy

1. click the "Deploy With Workers" button
2. follow the instructions to fork and deploy
3. update routes as you requirement

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ciiiii/cloudflare-docker-proxy)

## Routes configuration tutorial

1. use cloudflare worker host: only support proxy one registry
   ```javascript
   const routes = {
     "${workername}.${username}.workers.dev/": "https://registry-1.docker.io",
   };
   ```
2. use custom domain: support proxy multiple registries route by host
   - host your domain DNS on cloudflare
   - add `A` record of xxx.example.com to `192.0.2.1`
   - deploy this project to cloudflare workers
   - add `xxx.example.com/*` to HTTP routes of workers
   - add more records and modify the config as you need
   ```javascript
   const routes = {
     "docker.libcuda.so": "https://registry-1.docker.io",
     "quay.libcuda.so": "https://quay.io",
     "gcr.libcuda.so": "https://k8s.gcr.io",
     "k8s-gcr.libcuda.so": "https://k8s.gcr.io",
     "ghcr.libcuda.so": "https://ghcr.io",
   };
   ```


---

## 访问控制（可选，默认关闭）

本代理默认**完全开放**（不鉴权、不限流），与上游行为一致。
若要防止别人白嫖自己的域名 / 配额，可打开下面两个开关。

### 1. 鉴权

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUTH_ENABLED` | `false` | 总开关。设 `true` 后所有路径都要求凭据 |
| `AUTH_USERS` | 空 | `user1:pass1,user2:pass2`（密码可含冒号，用户名不行） |
| `AUTH_TOKEN` | 空 | 可选的固定 Bearer 令牌；留空则自动从 `AUTH_USERS` 派生 |

**不要把密码写进 `wrangler.toml`** —— 本仓库是公开的。用 Secret：

```bash
# 方式 A：面板 → Worker → Settings → Variables and Secrets → 加 Secret 类型
# 方式 B：命令行
npx wrangler secret put AUTH_USERS --env production
```

客户端怎么填：

* **群晖 Container Manager** → 注册表 → 编辑 → 在「用户名 / 密码」里填 `AUTH_USERS` 里的一对。
  代理用的是 HTTP **Basic** 挑战，正好对得上群晖的登录框。
* **docker CLI** → `docker login docker.example.com`（用户名/密码同上）。

> 代理会**剥掉**自己收到的凭据再转发上游，用户名密码不会流到 `registry-1.docker.io`。

### 2. 速率限制

| 变量 | 默认 | 说明 |
|---|---|---|
| `RATE_LIMIT_ENABLED` | `true` | 关掉写 `false` |
| `RATE_LIMIT_PER_MIN` | `600` | 每 IP 每分钟请求数；`/blobs/` 路径自动 ×4 |

按 `CF-Connecting-IP` 计数（Cloudflare 写入，客户端伪造无效），固定 60s 窗口。
超额返回 `429` + `Retry-After`。

> ⚠️ 这是**单 isolate 内存计数**，只做限流不做硬闸。要真正的硬限流请用
> Cloudflare 面板 → Security → WAF → Rate limiting rules。
> 默认额度（600/min，blobs 2400/min）足够正常 `docker pull`，不会误伤。

### 3. 验证开关是否生效

```bash
# 应当 401 + WWW-Authenticate: Basic
curl -i https://docker.example.com/v2/ | head -5

# 带上正确凭据应当 200
curl -i -u 'user1:pass1' https://docker.example.com/v2/library/redis/tags/list | head -5

# 匿名不该能拿到令牌
curl -i https://docker.example.com/v2/auth | head -5
```
