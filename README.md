# cloudflare-docker-proxy

> ### ⚠️ **Important Notice**
> <span style="color:#d73a49;font-weight:bold">Docker Hub is rate-limiting Cloudflare Worker IPs, causing frequent <code>429</code> errors.</span>  
> <span style="color:#d73a49;font-weight:bold">This project is currently NOT recommended for production use.</span>


Due to the current instability, this project is not recommended for production use.
We will provide updates as soon as more information becomes available.


![deploy](https://github.com/ga456rnet/cf-dproxy/actions/workflows/deploy.yaml/badge.svg)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ga456rnet/cf-dproxy)

> If you're looking for proxy for helm, maybe you can try [cloudflare-helm-proxy](https://github.com/ciiiii/cloudflare-helm-proxy).

## Deploy

1. click the "Deploy With Workers" button
2. follow the instructions to fork and deploy
3. **配置路由**（见下节）—— 不配的话访问自己的域名会直接 `404 HOST_NOT_CONFIGURED`

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ga456rnet/cf-dproxy)

> ⚠️ 请使用**本仓库**的按钮。上游 `ciiiii/cloudflare-docker-proxy` 的按钮点出来的是
> 未打补丁的版本：缺 `main` 字段会部署失败、`[vars]` 写在 `[env.*]` 里会 522、
> 没有 `library/` 前缀修复会导致群晖搜不到官方镜像。

## Routes configuration（路由表）

决定「哪个主机名 → 哪个上游 registry」。**用环境变量配，不用改源码。**

| 变量 | 说明 |
|---|---|
| `REGISTRY_ROUTES` | `host=upstream,host=upstream`，也接受 JSON。键支持精确主机名或 `*.example.com` 通配（匹配任意子域，**不含**裸域）；值必须带 `https://` |
| `DEFAULT_UPSTREAM` | 没有任何路由命中时的兜底上游。给"只用 `xxx.workers.dev`、只代理一个 registry"的场景用 |

**都不配**时回落到内置表（`*.aburling.dpdns.org` 那套），所以老部署行为不变。

例 1 —— 有自有域名，代理两个 registry：

```toml
[vars]
REGISTRY_ROUTES = "docker.example.com=https://registry-1.docker.io,ghcr.example.com=https://ghcr.io"
```

例 2 —— 没有域名，只有 `xxx.workers.dev`，只代理 Docker Hub：

```toml
[vars]
DEFAULT_UPSTREAM = "https://registry-1.docker.io"
```

然后在面板 **Settings → Domains & Routes → Add → Custom Domain** 里逐个绑定上面用到的主机名。

> ⚠️ `wrangler.toml` 里的 `CUSTOM_DOMAIN` 是**死变量**（代码里从没读过它），别拿它当路由配置。
> 真正生效的只有内置表 / `REGISTRY_ROUTES` / `DEFAULT_UPSTREAM` 三者。

<details>
<summary>老做法（HTTP Route + 占位 A 记录）</summary>

1. host your domain DNS on cloudflare
2. add `A` record of xxx.example.com to `192.0.2.1`
3. deploy this project to cloudflare workers
4. add `xxx.example.com/*` to HTTP routes of workers
5. add more records and modify the config as you need

⚠️ 这套和 Custom Domain **二选一**，同时用会报 `domain already in use`。

</details>


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

> ⚠️ **误配时是 fail-open，不是 fail-closed。**
> `AUTH_ENABLED=true` 但 `AUTH_USERS` 为空/不可解析时，代码**不拦截任何请求**
> （行为退回"没有门禁"）并打一条 `console.warn`。
> 原因：那种情况下凭据表是空表，fail-closed 会把**运维自己**也锁在外面且无后门。
> ⇒ **部署后务必确认 `AUTH_USERS` 真的配上了**，否则你以为有门禁、其实是裸奔。
> 三态自检：
>
> | 状态 | `/v2/` 无凭据 | `/v2/auth` 无凭据 |
> |---|---|---|
> | 鉴权关闭 | `401` + `Bearer` | `200` + `eyJ…` |
> | **门禁生效** ✅ | `401` + **`Basic`** | **`401`** |
> | 误配 fail-open ⚠️ | `401` + `Bearer` | `200` + `dpx…` |

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
