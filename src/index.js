/**
 * cf-dproxy — Cloudflare Worker Docker registry proxy (patched)
 *
 * 相对原版的三处修复（详见 FIX-NOTES.md）：
 *
 * [1] 不再直接引用裸全局变量 MODE / TARGET_UPSTREAM。
 *     wrangler 只有在 `deploy --env production` 时才会注入这两个变量
 *     （已用 `wrangler deploy --dry-run` 实测验证：
 *       带 --env production → MODE: "production" / TARGET_UPSTREAM: ""
 *       不带 --env          → "No bindings found."）。
 *     若用 Cloudflare 面板的 Git 集成 / "Deploy to Workers" 按钮部署，变量不会被注入，
 *     此时 `MODE == "debug"` 会抛 `ReferenceError: MODE is not defined`。
 *     这里改用 `typeof` 安全探测，变量缺失时回落到 production 语义。
 *
 * [2] 移除 `event.passThroughOnException()`。
 *     本项目没有真实源站（DNS 记录是 README 要求的 192.0.2.1 占位地址）。
 *     原版一旦抛异常，passThrough 会去连这个死地址，最终返回 Cloudflare 522
 *     "Connection timed out"，把真正的报错信息完全掩盖 —— 这正是本次故障的现象。
 *
 * [3] handleRequest 全程 try/catch，异常返回 500 + 错误详情，便于定位。
 *
 * [4] 新增 DSM / Portainer 等 UI 的「搜索注册表」兼容层（/v1/search）。
 *     这些 UI 的搜索框走 Docker Hub 旧版搜索 API，而本代理只实现 Registry
 *     协议（/v2/*），原本会落到路由兜底返回 `404 page not found`，
 *     UI 表现为「查询注册表失败」。详见 handleRequestInner 里的 /v1/search 分支。
 *     —— 该兼容层**只影响搜索**，任何情况下都不影响 pull。
 *
 * [5] 服务端匿名换票 —— 修「下载时查询注册表失败」（详见 retryWithAnonymousToken）。
 *
 * [6] Registry V1 兜底 /v1/repositories/<name>/tags（详见 registryV1TagsResponse）。
 *
 * [7] 轻量鉴权 + 速率限制（可选，默认关闭）。
 *     见下面 AUTH_* / RATE_LIMIT_* 配置块。默认 `AUTH_ENABLED=false`、
 *     `RATE_LIMIT_ENABLED=true`（额度宽松到不可能影响正常 pull）。
 *     关键约束：**代理自己的凭据绝不转发给上游**（见 stripUpstreamAuth）。
 *
 * 已移除：临时诊断用的「请求记录器」（REQLOG_* 常量 / 记录函数 / GET /__reqlog 路由）。
 *     它的作用是抓 DSM 到底发了什么请求，故障已定位并修复，故连同接口一并删除
 *     —— 留着一个匿名可读的请求日志接口本身就是信息泄露面。
 *     （回归测试 [14] 会断言这三样东西都不在源码里。）
 *
 * 兼容性：本文件仍使用 Service Worker 语法（addEventListener），
 * 与仓库现有 wrangler.toml（无 main 字段、compatibility_date = 2023-12-01）保持一致，
 * 部署命令无需改动。
 */

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request, event));
});

const dockerHub = "https://registry-1.docker.io";

// ---------------------------------------------------------------------------
// [4] 搜索上游候选列表（按顺序尝试，第一个成功即采用）
//
// 为什么需要多个：Docker Hub 的 Web 搜索 API 按 **出口 IP** 限流
// （实测响应头 x-ratelimit-limit: 180，即 180 次/小时/IP）。
// Cloudflare Worker 的出口 IP 是被海量 Worker 共享的，
// 实测从 Worker 发出的请求 **100% 返回 429 Rate limit exceeded**（连打 20 次全是 429）。
// registry.hub.docker.com 是 Docker 的旧主机名，数据完全相同，
// 但独立域名往往对应独立的限流桶 —— 放在第二个试。
// 两个都挂时，走 probeRepoName() 用 registry 协议做精确名校验兜底。
// ---------------------------------------------------------------------------
const SEARCH_UPSTREAMS = [
  "https://hub.docker.com/v2/search/repositories/",
  "https://registry.hub.docker.com/v2/search/repositories/",
];

// ---------------------------------------------------------------------------
// [1] 安全读取部署变量：未注入时返回默认值，绝不抛 ReferenceError
//     （typeof 作用于未声明的标识符是安全的，不会抛错）
// ---------------------------------------------------------------------------
const RUNTIME_MODE =
  typeof MODE !== "undefined" && MODE !== null ? String(MODE) : "production";
const RUNTIME_TARGET_UPSTREAM =
  typeof TARGET_UPSTREAM !== "undefined" && TARGET_UPSTREAM !== null
    ? String(TARGET_UPSTREAM)
    : "";

// ---------------------------------------------------------------------------
// [7] 轻量鉴权 + 速率限制
//
// 设计原则（三条，按优先级）：
//   1) **默认不改行为**。`AUTH_ENABLED` 默认 false，不设变量就等于没这层；
//      `RATE_LIMIT_PER_MIN` 默认额度大到正常 pull 永远碰不到。
//   2) **绝不破坏 pull**。见下面「凭据绝不转发上游」那段注释。
//   3) **不引入额外依赖**。全部基于 Worker 内存 + 环境变量，
//      不需要 KV / D1 / Durable Objects（免费额度够用，也不用配存储）。
//
// 环境变量（在 Cloudflare 面板 Worker → Settings → Variables 里加，
// 或写进 wrangler.toml 的 [vars]；密码类建议用 Secrets 而不是明文 var）：
//
//   AUTH_ENABLED       "false" | "true"          总开关，默认 false
//   AUTH_USERS         "user1:pass1,user2:pass2" 允许的用户名/密码对（ASCII）
//   AUTH_TOKEN         "..."                     可选的固定 Bearer 令牌；留空则自动派生
//   RATE_LIMIT_ENABLED "true" | "false"          默认 true
//   RATE_LIMIT_PER_MIN "600"                     每 IP 每分钟额度，默认 600
//
// 为什么选 HTTP Basic 作为主载体：
//   群晖「Container Manager → 注册表」的登录表单**只有用户名 + 密码两个框**，
//   它能表达的凭据形式只有 Basic。所以 Basic 是唯一对群晖零改造的载体。
//   Bearer 作为**第二载体**兼容 docker CLI 的 token 流程（见 /v2/auth 分支）。
//
// ⚠️ 已知边界（务必知道）：
//   a) 速率限制是**单 isolate 内存计数**，Cloudflare 会在多个 isolate / colo
//      之间分摊请求，所以它只是「限流」，不是「硬闸」。真正的硬限流要用
//      Cloudflare 面板的 Security → WAF → Rate limiting rules（免费版可用）。
//   b) 启用鉴权后，客户端**自带的**上游凭据不能再透传（因为它和我们的凭据
//      走同一个 Authorization 头，无法区分）。群晖本来就不带上游凭据，不受影响。
//   c) Basic 的密码用 UTF-8 解码，但建议只用 ASCII —— 部分客户端按 latin1 编码。
// ---------------------------------------------------------------------------
// 注意命名：本文件的局部常量**不能**叫 AUTH_ENABLED / AUTH_USERS / AUTH_TOKEN /
// RATE_LIMIT_*，否则会遮蔽同名环境变量，`typeof X` 会撞上 TDZ 直接抛
// "Cannot access 'X' before initialization"。所以局部一律改名
// （AUTH_ON / AUTH_TOKEN_ISSUED / RATE_LIMIT_ON ...），读全局时才用原始名。
const AUTH_ON =
  typeof AUTH_ENABLED !== "undefined" && String(AUTH_ENABLED).toLowerCase() === "true";
const AUTH_USERS_RAW = typeof AUTH_USERS !== "undefined" ? String(AUTH_USERS) : "";
const AUTH_TOKEN_RAW = typeof AUTH_TOKEN !== "undefined" ? String(AUTH_TOKEN) : "";

// 速率限制默认**开**（额度宽松到正常 pull 碰不到），只有显式写 false 才关。
const RATE_LIMIT_ON =
  typeof RATE_LIMIT_ENABLED === "undefined" ||
  String(RATE_LIMIT_ENABLED).toLowerCase() !== "false";
const RATE_LIMIT_BUDGET = (() => {
  const v = typeof RATE_LIMIT_PER_MIN !== "undefined" ? parseInt(String(RATE_LIMIT_PER_MIN), 10) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 600;
})();

// "user1:pass1,user2:pass2" -> Map{user1 => pass1, ...}
// 密码里可以带冒号（只按**第一个**冒号切分），用户名里不行。
function parseAuthUsers(raw) {
  const map = new Map();
  if (!raw) return map;
  for (const pair of String(raw).split(",")) {
    const s = pair.trim();
    if (!s) continue;
    const i = s.indexOf(":");
    if (i <= 0) continue;
    const user = s.slice(0, i).trim();
    const pass = s.slice(i + 1);
    if (user) map.set(user, pass);
  }
  return map;
}
const AUTH_USERS_MAP = parseAuthUsers(AUTH_USERS_RAW);

// ---------------------------------------------------------------------------
// [7.1] 误配防御：AUTH_ENABLED=true 但 AUTH_USERS 为空/不可解析
//
// 没有这一层时的后果是**灾难性的**：凭据表为空 ⇒ checkAuth 对任何请求都返回
// ok=false ⇒ **所有请求 401，包括运维自己**。而且代码里没有任何后门，
// 只能去面板把 AUTH_ENABLED 改回 false 才能恢复。
//
// 对「防白嫖」这类场景（挡的是滥用，不是保护机密），误配应该**降级成"没有门禁"**
// （= 与加鉴权之前完全一致），而不是"服务全死"。所以这里 fail-open。
//
// 可见性：misconfigured 时会打 warn（Cloudflare 面板 → Worker → Logs 可见），
// 并且 /v2/auth 会**退回上游流程**（返回上游 token 而不是空 token），
// 所以外部可以据此判断当前处于哪种状态：
//   /v2/auth 无凭据 → 401         = 门禁已生效
//   /v2/auth 无凭据 → 200 + eyJ…  = 鉴权关闭
//   /v2/auth 无凭据 → 200 + dpx…  = 门禁生效但由本代理签发（正常）
// ---------------------------------------------------------------------------
const AUTH_MISCONFIGURED = AUTH_ON && AUTH_USERS_MAP.size === 0;
const AUTH_GATE_ACTIVE = AUTH_ON && !AUTH_MISCONFIGURED;
if (AUTH_MISCONFIGURED) {
  console.warn(
    "[cf-dproxy] AUTH_ENABLED=true 但 AUTH_USERS 为空或不可解析 —— 已 fail-open（不拦截任何请求）。" +
      "请在面板配置 AUTH_USERS（Secret，格式 user1:pass1,user2:pass2）后重新部署。"
  );
}

// 恒定时间比较 —— 避免用 `===` 逐字符短路比较泄露长度/前缀信息。
function safeEqual(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

// FNV-1a：只用来把 AUTH_USERS 派生成一个**客户端猜不出**的令牌。
// 安全性来自"AUTH_USERS 是秘密"，不是来自这个哈希 —— 所以它只当第二载体用，
// 主载体始终是 Basic。未配置 AUTH_TOKEN 时自动派生，省得用户多配一个变量。
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}
const AUTH_TOKEN_ISSUED =
  AUTH_TOKEN_RAW ||
  (AUTH_USERS_RAW
    ? "dpx" +
      fnv1a(AUTH_USERS_RAW + "|cf-dproxy").toString(36) +
      fnv1a("cf-dproxy|" + AUTH_USERS_RAW).toString(36)
    : "");

// 解出 Basic 凭据。用 TextDecoder 解 UTF-8（atob 只给 latin1）。
function decodeBasic(headerValue) {
  const m = /^basic\s+([A-Za-z0-9+/=]+)$/i.exec(String(headerValue || "").trim());
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const text = new TextDecoder("utf-8").decode(bytes);
    const i = text.indexOf(":");
    if (i < 0) return null;
    return { user: text.slice(0, i), pass: text.slice(i + 1) };
  } catch (e) {
    return null;
  }
}

// 返回 { ok, ours, via }
//   ok   —— 是否放行
//   ours —— 这个 Authorization 头是"代理自己的凭据"（= 转发上游前必须删掉）
// 鉴权关闭时一律放行，且 ours=false（保持原样透传，行为与改动前完全一致）。
// 误配（AUTH_ENABLED=true 但 AUTH_USERS 为空）同样放行 —— 见上面 [7.1]。
function checkAuth(request) {
  if (!AUTH_GATE_ACTIVE) {
    return { ok: true, ours: false, via: AUTH_MISCONFIGURED ? "misconfigured-open" : "off" };
  }

  const h = request.headers.get("Authorization");
  if (!h) return { ok: false, ours: false, via: null };

  const basic = decodeBasic(h);
  if (basic) {
    if (AUTH_USERS_MAP.has(basic.user) && safeEqual(AUTH_USERS_MAP.get(basic.user), basic.pass)) {
      return { ok: true, ours: true, via: "basic", user: basic.user };
    }
    return { ok: false, ours: false, via: null };
  }

  const bm = /^bearer\s+(.+)$/i.exec(String(h).trim());
  if (bm) {
    const tok = bm[1].trim();
    if (AUTH_TOKEN_ISSUED && safeEqual(AUTH_TOKEN_ISSUED, tok)) return { ok: true, ours: true, via: "bearer" };
    // 也接受"密码直接当令牌"——某些客户端只会填一个 token 框
    for (const pass of AUTH_USERS_MAP.values()) {
      if (pass && safeEqual(pass, tok)) return { ok: true, ours: true, via: "bearer" };
    }
  }
  return { ok: false, ours: false, via: null };
}

// ---------------------------------------------------------------------------
// [7] 速率限制 —— 固定窗口（每分钟一个桶），按 CF-Connecting-IP 计数
//
// CF-Connecting-IP 由 Cloudflare 边缘写入且会覆盖客户端伪造值，可作可信来源。
// 拿不到时退回 UA 哈希，避免把所有匿名请求挤进同一个桶。
//
// 分两档额度：/blobs/ 是 pull 热路径（一个多层镜像可能几十个 blob），
// 给 4 倍额度；其余路径（搜索 / tags/list / manifests）是刷接口的主要入口，
// 用基准额度。这样"正常拉一个镜像"永远撞不到限流。
// ---------------------------------------------------------------------------
const RATE_STATE = new Map();
const RATE_WINDOW_MS = 60000;
let RATE_LAST_SWEEP = 0;

function rateKeyOf(request) {
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) return "ip:" + ip;
  const ua = request.headers.get("user-agent") || "";
  return "ua:" + fnv1a(ua).toString(36);
}

function rateLimitHit(key, budget) {
  const now = Date.now();
  const bucket = Math.floor(now / RATE_WINDOW_MS);
  let rec = RATE_STATE.get(key);
  if (!rec || rec.bucket !== bucket) {
    rec = { bucket: bucket, count: 0 };
    RATE_STATE.set(key, rec);
  }
  rec.count++;
  // 偶发清理过期桶，防止 isolate 长驻时 Map 无限增长
  if (RATE_STATE.size > 5000 && now - RATE_LAST_SWEEP > RATE_WINDOW_MS) {
    RATE_LAST_SWEEP = now;
    for (const [k, v] of RATE_STATE) {
      if (v.bucket !== bucket) RATE_STATE.delete(k);
    }
  }
  return { count: rec.count, over: rec.count > budget };
}

function responseTooManyRequests(retryAfterSec) {
  const headers = new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("retry-after", String(retryAfterSec));
  headers.set("docker-distribution-api-version", "registry/2.0");
  return new Response(
    JSON.stringify({
      errors: [
        {
          code: "TOOMANYREQUESTS",
          message: "too many requests, slow down",
          detail: null,
        },
      ],
    }),
    { status: 429, headers: headers }
  );
}

// 鉴权未通过时的 401 —— 用 **Basic** 挑战（群晖的登录框就是用户名+密码）。
function responseAuthRequired() {
  const headers = new Headers();
  headers.set("WWW-Authenticate", 'Basic realm="cf-dproxy", charset="UTF-8"');
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("docker-distribution-api-version", "registry/2.0");
  return new Response(
    JSON.stringify({
      errors: [
        {
          code: "UNAUTHORIZED",
          message: "authentication required",
          detail: "此代理已启用访问控制，请在注册表登录处填写用户名与密码。",
        },
      ],
    }),
    { status: 401, headers: headers }
  );
}

// ---------------------------------------------------------------------------
// [8] 路由表可配置化：让**同一份代码**能服务多个实例（自己用 + 给别人部署）
//
// 背景（为什么必须改）：
//   原版把路由表硬编码成 `*.aburling.dpdns.org`，于是：
//     ① 别人把这个项目部署到**自己的** Cloudflare 账号后，请求
//        `xxx.<account>.workers.dev` 或自己的域名 → 命中不了任何 key →
//        直接 `HOST_NOT_CONFIGURED` 404，看起来像"部署失败"，其实是配置缺失；
//     ② 每来一个使用者就要改一次源码 → 无法做「一键部署」。
//   `wrangler.toml` 里的 `CUSTOM_DOMAIN` 是个**死变量**（代码里从没读过它），
//   别被它误导 —— 真正生效的只有下面这张表。
//
// 现在：优先读环境变量，**没配就回落到原来的硬编码表** ⇒ 对现有部署零影响。
//
//   REGISTRY_ROUTES   "docker.a.com=https://registry-1.docker.io,*.b.com=https://ghcr.io"
//                     也接受 JSON：{"docker.a.com":"https://registry-1.docker.io"}
//                     键 = 主机名（精确匹配，大小写不敏感），或以 `*.` 开头的通配
//                          （匹配其任意**子域**，不含裸域本身）
//                     值 = 上游 registry 基址（必须带 https://）
//   DEFAULT_UPSTREAM  "https://registry-1.docker.io"
//                     没有任何路由命中时的兜底上游。给"只用 workers.dev、
//                     只代理一个 registry"的场景用；不配则无命中的主机仍返回 404。
//
// ⚠️ 命名规则同 [7]：本文件的局部常量**不能**叫 REGISTRY_ROUTES / DEFAULT_UPSTREAM，
//    否则会遮蔽同名环境变量，`typeof X` 撞上 TDZ 直接抛错。故加 `_RAW` 后缀。
// ---------------------------------------------------------------------------
const REGISTRY_ROUTES_RAW =
  typeof REGISTRY_ROUTES !== "undefined" && REGISTRY_ROUTES !== null
    ? String(REGISTRY_ROUTES)
    : "";
const DEFAULT_UPSTREAM_RAW =
  typeof DEFAULT_UPSTREAM !== "undefined" && DEFAULT_UPSTREAM !== null
    ? String(DEFAULT_UPSTREAM)
    : "";

/**
 * 解析 REGISTRY_ROUTES。支持 `host=upstream,host=upstream` 与 JSON 对象两种形态。
 * 返回**无原型**对象（`Object.create(null)`）：
 *   - 防止 `__proto__` / `constructor` 这类键污染原型链
 *   - 同时让 `__proto__` 变成一个普通 key（永不匹配主机名，无害）
 * 解析失败的片段只打 warn 跳过，**绝不抛错**（配置写错不该让服务起不来）。
 */
function parseRoutes(raw) {
  const out = Object.create(null);
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return out;

  const put = (host, upstream) => {
    const h = String(host == null ? "" : host).trim().toLowerCase();
    const u = String(upstream == null ? "" : upstream).trim();
    if (!h || !u) return;
    if (!/^https?:\/\//i.test(u)) {
      console.warn("[cf-dproxy] REGISTRY_ROUTES 上游缺少 http(s):// 前缀，已跳过：" + h + "=" + u);
      return;
    }
    out[h] = u;
  };

  // 形态一：JSON 对象
  if (text.charAt(0) === "{") {
    try {
      const obj = JSON.parse(text);
      for (const k of Object.keys(obj)) put(k, obj[k]);
    } catch (e) {
      console.warn("[cf-dproxy] REGISTRY_ROUTES 不是合法 JSON，已忽略整串：" + e.message);
    }
    return out;
  }

  // 形态二：host=upstream,host=upstream
  for (const seg of text.split(",")) {
    const s = seg.trim();
    if (!s) continue;
    const i = s.indexOf("=");
    if (i <= 0) {
      console.warn("[cf-dproxy] REGISTRY_ROUTES 片段缺少 `=`，已跳过：" + s);
      continue;
    }
    put(s.slice(0, i), s.slice(i + 1));
  }
  return out;
}

// 原硬编码表 —— 保持原样，作为"没配 REGISTRY_ROUTES"时的默认值。
const DEFAULT_ROUTES = {
  // production
  ["docker.aburling.dpdns.org"]: dockerHub,
  ["quay.aburling.dpdns.org"]: "https://quay.io",
  ["gcr.aburling.dpdns.org"]: "https://gcr.io",
  ["k8s-gcr.aburling.dpdns.org"]: "https://k8s.gcr.io",
  ["k8s.aburling.dpdns.org"]: "https://registry.k8s.io",
  ["ghcr.aburling.dpdns.org"]: "https://ghcr.io",
  ["ecr.aburling.dpdns.org"]: "https://public.ecr.aws",
  // 注：原表里的 cloudsmith.aburling.dpdns.org 已删除 ——
  //     该主机名在 DNS 里根本不存在（Cloudflare 面板没建 Custom Domain），
  //     留着只会让人以为"能用"。要恢复：先在面板建 Custom Domain，
  //     再把 ["cloudsmith.aburling.dpdns.org"]: "https://docker.cloudsmith.io" 加回来。

  // staging
  ["docker-staging.aburling.dpdns.org"]: dockerHub,
};

const ROUTES_FROM_ENV = parseRoutes(REGISTRY_ROUTES_RAW);
const ROUTES_SOURCE = Object.keys(ROUTES_FROM_ENV).length ? "env" : "default";
const routes = ROUTES_SOURCE === "env" ? ROUTES_FROM_ENV : DEFAULT_ROUTES;

if (ROUTES_SOURCE === "env") {
  console.log(
    "[cf-dproxy] 路由表来自 REGISTRY_ROUTES（" +
      Object.keys(routes).length +
      " 条）：" +
      Object.keys(routes).join(", ")
  );
} else if (DEFAULT_UPSTREAM_RAW) {
  console.log(
    "[cf-dproxy] 未配 REGISTRY_ROUTES，使用硬编码默认表；无命中时兜底到 " + DEFAULT_UPSTREAM_RAW
  );
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * 主机名 → 上游 registry。
 * 匹配顺序：① 精确（大小写不敏感）→ ② `*.` 通配子域 → ③ DEFAULT_UPSTREAM → ④ debug 兜底。
 * 全部不中返回 ""（调用方据此返回 HOST_NOT_CONFIGURED 404）。
 */
function routeByHosts(host) {
  const h = String(host == null ? "" : host).trim().toLowerCase();
  if (!h) return "";

  // ① 精确匹配。用 hasOwnProperty 而不是 `in` —— 否则 "constructor" / "toString"
  //    这类主机名会顺着原型链命中 Object.prototype 上的成员，返回一个函数当上游。
  if (hasOwn(routes, h)) {
    return routes[h];
  }

  // ② `*.example.com` 通配：匹配任意子域，但**不含**裸域 example.com 本身
  //    （要裸域就再写一条精确规则）。
  for (const key of Object.keys(routes)) {
    if (key.length > 2 && key.slice(0, 2) === "*.") {
      const suffix = key.slice(1); // ".example.com"
      if (h.length > suffix.length && h.slice(-suffix.length) === suffix) {
        return routes[key];
      }
    }
  }

  // ③ 兜底上游（单 registry / workers.dev 场景）
  if (DEFAULT_UPSTREAM_RAW) {
    return DEFAULT_UPSTREAM_RAW;
  }

  // ④ 本地调试
  if (RUNTIME_MODE === "debug") {
    return RUNTIME_TARGET_UPSTREAM;
  }
  return "";
}

// ---------------------------------------------------------------------------
// [3] 异常兜底：把 Worker 内部错误变成可读的 500，而不是 522
// ---------------------------------------------------------------------------
async function handleRequest(request, event) {
  try {
    return await handleRequestInner(request, event);
  } catch (err) {
    let host = "";
    try {
      host = new URL(request.url).hostname;
    } catch (e) {
      /* ignore */
    }
    return new Response(
      JSON.stringify(
        {
          error: "WORKER_EXCEPTION",
          message: err && err.message ? err.message : String(err),
          host: host,
          mode: RUNTIME_MODE,
          hint: "Worker 内部抛异常。若 message 含 'is not defined'，说明该部署缺少对应环境变量。",
        },
        null,
        2
      ),
      {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      }
    );
  }
}

async function handleRequestInner(request, event) {
  const url = new URL(request.url);

  if (url.pathname == "/") {
    return Response.redirect(url.protocol + "//" + url.host + "/v2/", 301);
  }
  const upstream = routeByHosts(url.hostname);
  if (upstream === "") {
    // 主机名不在路由表里 —— 这就是"自定义域 404"的来源
    return new Response(
      JSON.stringify(
        {
          error: "HOST_NOT_CONFIGURED",
          message:
            "该主机名不在路由表里。请把它的主机名加进环境变量 REGISTRY_ROUTES" +
            "（形如 docker.example.com=https://registry-1.docker.io，" +
            "支持 *.example.com 通配），" +
            "若只想代理一个 registry、任意主机名都放行，就设 DEFAULT_UPSTREAM。",
          receivedHost: url.hostname,
          routesSource: ROUTES_SOURCE, // env = 来自 REGISTRY_ROUTES；default = 内置表
          routes: routes,
        },
        null,
        2
      ),
      {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
      }
    );
  }
  const isDockerHub = upstream == dockerHub;

  // ---------------------------------------------------------------------------
  // [7] 访问控制闸门（鉴权 + 速率限制）
  //
  // 位置讲究：放在 routes 解析**之后**，这样"主机名没配"仍然返回带 routes 表的
  // 404（这是排障时最有用的一条信息），不会被 401 盖掉。
  //
  // 两条独立的闸门，互不耦合：
  //   1) 鉴权（默认关）：不通过 -> 401 + Basic 挑战。
  //   2) 速率限制（默认开）：超额度 -> 429 + Retry-After。
  // ---------------------------------------------------------------------------
  const authResult = checkAuth(request);
  if (!authResult.ok) {
    return responseAuthRequired();
  }
  // 客户端带的是"我们自己的凭据" -> 转发上游前必须删掉它。
  // 这是本层最关键的一条约束：代理的用户名密码绝不能流到 registry-1.docker.io。
  const stripUpstreamAuth = authResult.ours;
  let authorization = stripUpstreamAuth ? null : request.headers.get("Authorization");

  if (RATE_LIMIT_ON) {
    const isBlob = url.pathname.includes("/blobs/");
    const budget = isBlob ? RATE_LIMIT_BUDGET * 4 : RATE_LIMIT_BUDGET;
    const rl = rateLimitHit(rateKeyOf(request), budget);
    if (rl.over) {
      return responseTooManyRequests(Math.ceil(RATE_WINDOW_MS / 1000));
    }
  }

  // ---------------------------------------------------------------------------
  // [4] DSM / Portainer 等 UI 的「搜索注册表」兼容层
  //
  // 背景：DSM「Container Manager → 注册表」的搜索框调的是 Docker Hub **旧版**
  //   搜索 API `GET /v1/search?q=&n=`，而本代理只实现 Registry 协议（/v2/*），
  //   所以请求会落到路由兜底 → `404 page not found`（text/plain），
  //   DSM 界面表现为「查询注册表失败」。
  //
  // 做法：把 /v1/search 映射到 Docker Hub **现行**公开搜索 API
  //   https://hub.docker.com/v2/search/repositories/?query=&page_size=
  //   并把字段改名成旧版格式（repo_name→name、short_description→description、
  //   count→num_results）。
  //
  // 实测要点（2026-09-25）：
  //   - 官方镜像上游返回的是**裸名**：`nginx`、`redis`（is_official=true）
  //   - 第三方镜像返回 `命名空间/仓库`：`vaultwarden/server`
  //   两者都**原样透传**。裸名交给下面已有的「DockerHub library 补全重定向」
  //   处理（/v2/nginx/manifests/latest → /v2/library/nginx/manifests/latest），
  //   因此不需要在这里补 `library/`，UI 里显示的名字也更友好。
  //
  // 安全边界：搜索是「锦上添花」，**绝不能拖累 pull**。
  //   所以任何异常/非 200/超时都吞掉，返回 200 + 空结果，
  //   让 UI 显示"无结果"而不是报错。
  // ---------------------------------------------------------------------------
  if (url.pathname === "/v1/search" || url.pathname === "/v1/search/") {
    // 参数名兼容：不同客户端用的名字不一样，只要有一个有值就用它。
    // 旧版 Docker Hub 搜索 API 用 `q`，但 DSM / Portainer / 各家 CLI 未必照抄。
    const q = (
      url.searchParams.get("q") ||
      url.searchParams.get("query") ||
      url.searchParams.get("name") ||
      url.searchParams.get("term") ||
      url.searchParams.get("keyword") ||
      ""
    ).trim();

    // -------------------------------------------------------------------------
    // 【关键修复】剥掉 DSM 硬加的 `library/` 前缀
    //
    // 实测（2026-09-25，抓 DSM 真实请求 + 上游对照）：
    //   DSM 搜索时发的 query 是 `library/<用户输入>`，空搜索时是 `library/`：
    //     GET /v1/search?q=library/vaultwarden&n=50&page=1
    //     GET /v1/search?q=library/memos&n=50&page=1
    //     GET /v1/search?q=library/&n=50&page=1
    //
    //   而 Docker Hub 上 `library/vaultwarden` **匹配不到任何东西**，
    //   于是它退化成一堆无关的流行镜像：
    //     q=library/vaultwarden -> count=8952   nginx / busybox / postgres / ubuntu
    //     q=library/memos       -> count=8935   nginx / busybox / postgres / ubuntu
    //   剥掉前缀后：
    //     q=vaultwarden         -> count=354    vaultwarden/server ✅
    //     q=memos               -> count=332    neosmemo/memos ✅
    //
    //   所以：带前缀就剥掉再查；剥完为空（=空搜索）就用 `library` 查，
    //   这样能列出官方镜像，正好符合 DSM「空搜索浏览」的预期。
    // -------------------------------------------------------------------------
    const LIBRARY_PREFIX = "library/";
    let qForSearch = q;
    let strippedPrefix = false;
    if (q.toLowerCase().startsWith(LIBRARY_PREFIX)) {
      const rest = q.slice(LIBRARY_PREFIX.length).trim();
      qForSearch = rest === "" ? "library" : rest;
      strippedPrefix = true;
    }

    const nRaw = parseInt(url.searchParams.get("n") || "25", 10);
    const n = Number.isFinite(nRaw) ? Math.min(Math.max(nRaw, 1), 100) : 25;
    const pageRaw = parseInt(url.searchParams.get("page") || "1", 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    // ?debug=1 —— 把上游诊断信息带进响应，便于排查"搜索返回 0 条"
    const debug = url.searchParams.get("debug") === "1";
    const diag = {
      receivedQuery: q,
      effectiveQuery: qForSearch,
      strippedLibraryPrefix: strippedPrefix,
      attempts: [],
      resolvedBy: null,
    };

    let results = null;
    let total = 0;

    // 只有 Docker Hub 有公开搜索 API。其他上游（ghcr/quay/gcr/ecr...）
    // 一律返回空结果 —— 让 UI 显示"无结果"，而不是"查询注册表失败"。
    if (qForSearch && isDockerHub) {
      // ---- 1) 依次尝试各搜索上游 ----
      const qs = `?query=${encodeURIComponent(qForSearch)}&page_size=${n}&page=${page}`;
      for (const base of SEARCH_UPSTREAMS) {
        const target = base + qs;
        const rec = { url: target, status: null, body: null, error: null };
        diag.attempts.push(rec);
        try {
          const resp = await fetchWithTimeout(
            target,
            {
              method: "GET",
              headers: {
                accept: "application/json",
                "user-agent": "cf-docker-proxy-search/1.0",
              },
              redirect: "follow",
            },
            8000
          );
          rec.status = resp.status;
          if (resp.ok) {
            const data = await resp.json();
            const list = Array.isArray(data && data.results) ? data.results : [];
            results = list
              .map((it) => ({
                name: it.repo_name || "",
                description: it.short_description || "",
                star_count: it.star_count || 0,
                is_official: !!it.is_official,
                is_automated: false,
              }))
              .filter((it) => it.name !== "");
            total = typeof data.count === "number" ? data.count : results.length;
            diag.resolvedBy = target;
            break;
          }
          try {
            rec.body = (await resp.text()).slice(0, 200);
          } catch (e) {
            /* ignore */
          }
        } catch (e) {
          rec.error = (e && e.message) || String(e);
        }
      }

      // ---- 2) 搜索上游全挂 → 用 registry 协议校验精确仓库名 ----
      //   能覆盖"用户已经知道镜像名，只想在 UI 里把它拉下来"这个真实场景。
      //   例：输入 `vaultwarden/server` → 命中；输入 `redis` → 命中 library/redis。
      if (results === null) {
        // 用剥过前缀的 qForSearch，避免拿 DSM 的 `library/vaultwarden` 去校验
        const candidates = qForSearch.includes("/")
          ? [qForSearch]
          : ["library/" + qForSearch, qForSearch];
        const found = [];
        for (const name of candidates) {
          const rec = { probe: name, exists: false, tagCount: null, error: null };
          diag.attempts.push(rec);
          try {
            const info = await probeRepoName(name);
            rec.exists = info.exists;
            rec.tagCount = info.tags ? info.tags.length : null;
            if (info.exists) {
              const sample = info.tags && info.tags.length ? info.tags.slice(0, 8) : [];
              found.push({
                name: name,
                description: sample.length
                  ? "精确名匹配 · 部分标签: " + sample.join(", ")
                  : "精确名匹配（该仓库无标签列表）",
                star_count: 0,
                is_official: name.startsWith("library/"),
                is_automated: false,
              });
            }
          } catch (e) {
            rec.error = (e && e.message) || String(e);
          }
        }
        results = found;
        total = found.length;
        if (found.length) diag.resolvedBy = "registry-name-probe";
      }
    }

    if (results === null) results = [];
    const body = { num_results: total, query: q, results: results };
    if (debug) body.debug = diag;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // ---------------------------------------------------------------------------
  // [6] Registry V1 兜底：/v1/repositories/<name>/tags
  //
  // 这是 DSM 在 /v2/<name>/tags/list 失败后的**降级路径**（实测日志坐实）。
  // 上游 V1 已下线（410 Gone），所以这里用 V2 接口自己拼 V1 格式的响应。
  //
  // 只在 Docker Hub 上游生效 —— 其他上游（ghcr/quay/...）本来就没有 V1 语义，
  // 硬造一个反而会误导客户端。
  //
  // 兜底原则：任何失败都不抛错，返回可解析的空数组，让 UI 显示"无标签"
  // 而不是"查询注册表失败"（和 /v1/search 的处理思路一致）。
  // ---------------------------------------------------------------------------
  if (isDockerHub && /^\/v1\/repositories\/.+\/tags\/?$/.test(url.pathname)) {
    const rawName = url.pathname
      .slice("/v1/repositories/".length)
      .replace(/\/tags\/?$/, "")
      .replace(/^\/+|\/+$/g, "");
    // -------------------------------------------------------------------------
    // 【关键修复 2026-09-25】裸名必须补 `library/` 前缀 —— 和下面 /v2 那条补全
    // 是同一件事，但这里原来漏了，直接导致群晖报「没有标签提供下载」。
    //
    // 实测证据（线上，修复前）：
    //   /v2/nginx/tags/list          -> 301     ← 群晖不跟随重定向
    //   /v1/repositories/nginx/tags  -> 200 []  ← 空数组 = 界面显示"没有标签"
    //   /v1/repositories/library/nginx/tags -> 200 [{"name":"1"},{"name":"1-alpine"},...]
    //
    // 原因：Docker Hub 上官方镜像的真实仓库名是 `library/nginx`，
    //   拿裸名 `nginx` 去 probeRepoName() 必然 404 → tags=null → 返回 []。
    //   而群晖搜索结果里官方镜像显示的就是**裸名**（nginx / redis / ubuntu ...），
    //   所以这条路径是它的必经之路，不补前缀就等于官方镜像全都没标签。
    //
    // 顺序：裸名（不含 `/`）几乎只可能是官方镜像，先试 `library/<name>`，
    //   再试裸名兜底（万一将来 Docker Hub 支持了顶层裸名仓库）。
    // -------------------------------------------------------------------------
    const candidates = rawName.includes("/")
      ? [rawName]
      : ["library/" + rawName, rawName];
    let tags = null;
    for (const name of candidates) {
      try {
        const info = await probeRepoName(name, 100);
        if (info.exists && Array.isArray(info.tags) && info.tags.length) {
          tags = info.tags;
          break;
        }
      } catch (e) {
        /* 吞掉 —— 兜底接口不能把请求变成 500 */
      }
    }
    if (tags === null) {
      // 空数组而不是 404：DSM 拿到 404 会报错，拿到 [] 只会显示"无标签"
      return registryV1TagsResponse([]);
    }
    return registryV1TagsResponse(tags);
  }

  // ---------------------------------------------------------------------------
  // 【故意不拦截 /v2/_catalog —— 这里是踩过的坑，别再改回去】
  //
  // DSM 每次搜索前都会先 GET /v2/_catalog。实测（2026-09-25 11:54 截图 + 11:39 日志对照）：
  //
  //   _catalog 返回 401（本代理默认行为，透传给 registry-1.docker.io）
  //     -> DSM 走 /v1/search，界面显示搜索结果            ✅ 搜索可用
  //
  //   _catalog 返回 200（曾"好心"返回官方镜像清单）
  //     -> DSM 切换到「目录浏览」模式，**把 catalog 当镜像列表显示，
  //        搜索框完全不参与过滤**，搜什么都是那 100 条官方镜像   ❌ 搜索失效
  //
  // 所以：**必须让 /v2/_catalog 保持 401**，DSM 才会用 /v1/search。
  // Docker Hub 本来就不对匿名开放目录，401 是符合协议的真实响应，不是缺陷。
  //
  // （Docker Hub 有上百万个仓库，catalog 在语义上也不可能列全，
  //   靠它来"搜索"从根上就不成立。）
  // ---------------------------------------------------------------------------

  if (url.pathname == "/v2/") {
    const newUrl = new URL(upstream + "/v2/");
    const headers = new Headers();
    if (authorization) {
      headers.set("Authorization", authorization);
    }
    // check if need to authenticate
    const resp = await fetch(newUrl.toString(), {
      method: "GET",
      headers: headers,
      redirect: "follow",
    });
    if (resp.status === 401) {
      return responseUnauthorized(url);
    }
    return resp;
  }
  // get token
  if (url.pathname == "/v2/auth") {
    // -------------------------------------------------------------------------
    // [7] 启用鉴权时，令牌由**我们自己**签发，不去问上游。
    //
    // 为什么必须短路：这个端点原本是"转发上游 /v2/ 拿挑战 → 换匿名 token"。
    // 若鉴权开着还照原样转发，任何人只要匿名请求 /v2/auth 就能拿到一个可用的
    // 匿名 token —— 鉴权形同虚设。
    //
    // 走到这里说明客户端**已经**通过了 checkAuth（否则上面就 401 了），
    // 所以直接回我们自己的令牌。令牌 = AUTH_TOKEN（未配置时由 AUTH_USERS 派生）。
    //
    // ⚠️ 判据用 AUTH_GATE_ACTIVE 而不是 AUTH_ON：
    //    误配（AUTH_ENABLED=true 但 AUTH_USERS 为空）时 AUTH_TOKEN_ISSUED 是空串，
    //    若照旧短路就会**返回一个空 token**，客户端会把它当有效令牌缓存起来。
    //    误配时退回下面的上游流程，行为与"鉴权关闭"完全一致。
    // -------------------------------------------------------------------------
    if (AUTH_GATE_ACTIVE) {
      return new Response(
        JSON.stringify({
          token: AUTH_TOKEN_ISSUED,
          access_token: AUTH_TOKEN_ISSUED,
          expires_in: 3600,
          issued_at: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        }
      );
    }
    const newUrl = new URL(upstream + "/v2/");
    const resp = await fetch(newUrl.toString(), {
      method: "GET",
      redirect: "follow",
    });
    if (resp.status !== 401) {
      return resp;
    }
    const authenticateStr = resp.headers.get("WWW-Authenticate");
    if (authenticateStr === null) {
      return resp;
    }
    const wwwAuthenticate = parseAuthenticate(authenticateStr);
    let scope = url.searchParams.get("scope");
    // autocomplete repo part into scope for DockerHub library images
    // Example: repository:busybox:pull => repository:library/busybox:pull
    if (scope && isDockerHub) {
      let scopeParts = scope.split(":");
      if (scopeParts.length == 3 && !scopeParts[1].includes("/")) {
        scopeParts[1] = "library/" + scopeParts[1];
        scope = scopeParts.join(":");
      }
    }
    return await fetchToken(wwwAuthenticate, scope, authorization);
  }
  // ---------------------------------------------------------------------------
  // DockerHub 官方镜像的 `library/` 补全 —— 【内部改写，不再返回 301】
  // Example: /v2/busybox/manifests/latest => /v2/library/busybox/manifests/latest
  //
  // 为什么从 `Response.redirect(..., 301)` 改成改写 pathname（2026-09-25 实测）：
  //
  //   群晖 Container Manager 请求 /v2/nginx/tags/list 拿到 **301 后不会跟随**，
  //   而是判定"取不到标签"→ 回落到 V1 兜底 → 兜底也拿不到就报
  //   「没有标签提供下载」。而 DSM 搜索结果里官方镜像显示的就是**裸名**
  //   （nginx / redis / ubuntu ...），所以这条路径是它的必经之路。
  //
  //   内部改写后 /v2/nginx/tags/list 直接返回 200 + 真实 tags，
  //   完全不依赖客户端会不会跟随重定向。
  //
  // 对 docker CLI 无影响：它本来就会自己把 `nginx` 规范化成 `library/nginx`
  //   （基本不会走到这里），而且收到 200 比收到 301 更好。
  //
  // ⚠️ 改写必须发生在 `pullScopeFromPath()` 之前 —— 它靠 pathname 推导
  //    `repository:<name>:pull` 换票作用域。改写后 name 才是正确的 `library/nginx`。
  // ---------------------------------------------------------------------------
  if (isDockerHub && url.pathname.startsWith("/v2/")) {
    const pathParts = url.pathname.split("/");
    if (pathParts.length == 5) {
      pathParts.splice(2, 0, "library");
      url.pathname = pathParts.join("/");
    }
  }
  // foward requests
  const newUrl = new URL(upstream + url.pathname);
  // [7] 转发前把"代理自己的凭据"摘掉 —— 用户名密码绝不能流到上游 registry。
  //     鉴权关闭时 stripUpstreamAuth 恒为 false，headers 原样透传（行为不变）。
  let forwardHeaders = request.headers;
  if (stripUpstreamAuth) {
    forwardHeaders = new Headers(request.headers);
    forwardHeaders.delete("Authorization");
  }
  const newReq = new Request(newUrl, {
    method: request.method,
    headers: forwardHeaders,
    // don't follow redirect to dockerhub blob upstream
    redirect: isDockerHub ? "manual" : "follow",
  });
  let resp = await fetch(newReq);

  // ---------------------------------------------------------------------------
  // [5] 【服务端匿名换票】—— 修群晖 Container Manager「下载时查询注册表失败」
  //
  // 实测（2026-09-25 请求日志 + 时间戳，证据在 SYNOLOGY-TROUBLESHOOT.md 附录 K）：
  //   04:05:19.651 GET /v2/vaultwarden/server/tags/list      auth=False   ← DSM
  //   04:05:20.943 GET /v1/repositories/vaultwarden/server/tags          ← 1.29s 后降级
  //   04:10:42.438 GET /v2/apursuer/vaultwarden/tags/list    auth=False
  //   04:10:43.668 GET /v1/repositories/apursuer/vaultwarden/tags        ← 1.23s 后降级
  //
  //   两条关键事实：
  //     a) DSM 全程**没有**请求过 /v2/auth。日志里的 /v2/auth 全是本地 curl 探针
  //        （UA=curl/8.13.0），DSM 的请求 UA 是空串。
  //        => DSM **不做 Bearer 换票**：匿名请求 tags/list → 拿 401 → 直接放弃。
  //     b) DSM 的降级路径是 Registry V1 API `/v1/repositories/<name>/tags`，
  //        而 V1 早已下线：registry.hub.docker.com/v1/... 现在返回 **410 Gone**。
  //        => 降级路径也是死的，两条路全断 → 界面报「查询注册表失败」。
  //
  //   所以把 401 body 写得更"标准"是**没用**的（DSM 根本不解析它），
  //   正确做法是**由代理替客户端换票**：
  //     上游 401 → 读它的 WWW-Authenticate → 匿名换 pull token → 带 token 重试 → 200
  //   客户端全程看不到 401，自然不需要它有换票能力。
  //
  // 边界（三条，缺一不可）：
  //   1) 只在客户端**没带** Authorization 时注入。带了就说明客户端自己会换票
  //      （docker CLI 就是），保持标准 401 挑战流程，别抢它的活。
  //   2) **作用域只限 scoped 路径**（manifests / blobs / tags）。`/v2/` 与
  //      `/v2/_catalog` 的 `pullScopeFromPath()` 返回 null → 自动排除。
  //      尤其 _catalog 一旦返回 200，DSM 会切到「目录浏览」模式、搜索框失效 ——
  //      这个坑踩过一次了（见上面那段注释），所以这里必须让它继续 401。
  //   3) 换票或重试失败 → 原样退回标准 401，不吞错误。
  // ---------------------------------------------------------------------------
  if (resp.status === 401 && !authorization) {
    const pullScope = pullScopeFromPath(url.pathname);
    if (pullScope) {
      const injected = await retryWithAnonymousToken(newReq, resp, pullScope);
      if (injected) resp = injected;
    }
  }

  if (resp.status == 401) {
    return responseUnauthorized(url);
  }
  // handle dockerhub blob redirect manually
  if (isDockerHub && resp.status == 307) {
    const location = new URL(resp.headers.get("Location"));
    const redirectResp = await fetch(location.toString(), {
      method: "GET",
      redirect: "follow",
    });
    return redirectResp;
  }
  return resp;
}

// ---------------------------------------------------------------------------
// [4] 带超时的 fetch —— 仅用于搜索兼容层。
//     搜索上游（hub.docker.com）若挂起，不能让 Worker 一直等，
//     否则会耗尽请求预算并可能影响同期的 pull 请求。
// ---------------------------------------------------------------------------
function fetchWithTimeout(input, init, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const opts = Object.assign({}, init || {}, { signal: controller.signal });
  return fetch(input, opts).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// [4] 用 registry 协议校验"某个仓库名在 Docker Hub 上是否存在"
//
// 走的是和 pull 完全相同的接口（/v2/ 挑战 → token → tags/list），
// 因此不受 hub.docker.com 那套 Web API 限流影响。
//
// 返回 { exists: boolean, tags: string[]|null }
// ---------------------------------------------------------------------------
async function probeRepoName(name, limit) {
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 10;
  const base = "https://registry-1.docker.io";
  const challenge = await fetch(base + "/v2/", {
    method: "GET",
    redirect: "follow",
  });
  if (challenge.status !== 401) return { exists: false, tags: null };

  const authStr = challenge.headers.get("WWW-Authenticate");
  if (!authStr) return { exists: false, tags: null };

  const wa = parseAuthenticate(authStr);
  const tokResp = await fetchToken(wa, `repository:${name}:pull`, null);
  if (!tokResp.ok) return { exists: false, tags: null };

  const tokJson = await tokResp.json();
  const token = tokJson.token || tokJson.access_token;
  if (!token) return { exists: false, tags: null };

  // ?n=10 —— OCI 分发规范的分页参数，Docker Hub 支持；不支持时会被忽略
  const r = await fetch(`${base}/v2/${name}/tags/list?n=${n}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  if (r.status !== 200) return { exists: false, tags: null };

  let tags = null;
  try {
    const d = await r.json();
    tags = Array.isArray(d && d.tags) ? d.tags : null;
  } catch (e) {
    /* 200 但 body 不可解析 —— 仍然算存在 */
  }
  return { exists: true, tags: tags };
}

// ---------------------------------------------------------------------------
// [5] 从 registry 路径推导 pull scope
//
//   /v2/<name...>/manifests/<ref>   -> repository:<name>:pull
//   /v2/<name...>/blobs/<digest>    -> repository:<name>:pull
//   /v2/<name...>/tags/list         -> repository:<name>:pull
//   /v2/                            -> null   （无 scope，故意不注入）
//   /v2/_catalog                    -> null   （故意不注入，见上面 _catalog 那段注释）
//
// 注意：官方镜像的 `library/` 前缀由上面已有的 301 补全重定向处理
// （`/v2/busybox/tags/list` 5 段 → `/v2/library/busybox/tags/list`），
// 所以这里拿到的 name 已经是可直接喂给 auth 服务的正确形式。
// ---------------------------------------------------------------------------
function pullScopeFromPath(pathname) {
  const parts = pathname.split("/").filter((s) => s !== "");
  if (parts.length < 2 || parts[0] !== "v2") return null;
  const idx = parts.findIndex(
    (s, i) => i >= 1 && (s === "manifests" || s === "blobs" || s === "tags")
  );
  if (idx < 2) return null;
  const name = parts.slice(1, idx).join("/");
  if (!name) return null;
  return `repository:${name}:pull`;
}

// ---------------------------------------------------------------------------
// [5] 用匿名 token 重试一次上游请求
//
// 给「不做 Bearer 换票的客户端」用（群晖 Container Manager 就是这类）。
// 返回重试后的 Response；任何一步不成功都返回 null，由调用方退回标准 401。
//
// 只在「匿名可读」的场景下才会成功 —— 私有仓库拿到的 token 仍然无权，
// 重试依旧 401，于是返回 null，行为与改动前一致（不会把私有仓库放行）。
// ---------------------------------------------------------------------------
async function retryWithAnonymousToken(originalReq, challengeResp, pullScope) {
  try {
    const authStr = challengeResp.headers.get("WWW-Authenticate");
    // 只处理 Bearer 挑战。Basic 挑战不碰（本代理也不转发凭据）。
    if (!authStr || !/^bearer/i.test(authStr.trim())) return null;

    const wa = parseAuthenticate(authStr);
    const tokResp = await fetchToken(wa, pullScope, null);
    if (!tokResp.ok) return null;

    const tokJson = await tokResp.json();
    const token = (tokJson && (tokJson.token || tokJson.access_token)) || "";
    if (!token) return null;

    const headers = new Headers(originalReq.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const retryReq = new Request(originalReq, { headers: headers });
    const retry = await fetch(retryReq);
    // 重试还 401 说明该 token 无权（私有仓库）→ 交给调用方走标准 401
    return retry.status === 401 ? null : retry;
  } catch (e) {
    // 换票失败绝不能把请求变成 500，退回标准 401 即可
    return null;
  }
}

// ---------------------------------------------------------------------------
// [6] Registry V1 兜底：/v1/repositories/<name>/tags
//
// 群晖 Container Manager 在 /v2/<name>/tags/list 失败后会降级调这个已废弃的
// V1 接口（实测日志：v2 tags/list → 1.2s 后 v1 repositories/tags）。
// 上游 V1 已下线（registry.hub.docker.com/v1/... 返回 410 Gone），
// 所以这里用 V2 接口自己拼一个 V1 格式的响应。
//
// ⚠️ 正常情况下用不到它 —— 上面的「服务端匿名换票」已经让 v2 tags/list 返回 200。
//    留着它纯粹是最后一道保险：万一换票失败，DSM 至少还能拿到标签列表。
//    格式是**逆向重建**的（V1 接口已死，无法对照），只保证 `name` 字段正确。
// ---------------------------------------------------------------------------
function registryV1TagsResponse(tags) {
  const v1 = tags.map((t) => ({ layer: "", name: t }));
  return new Response(JSON.stringify(v1), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parseAuthenticate(authenticateStr) {
  // sample: Bearer realm="https://auth.ipv6.docker.com/token",service="registry.docker.io"
  // match strings after =" and before "
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
  const matches = authenticateStr.match(re);
  if (matches == null || matches.length < 2) {
    throw new Error(`invalid Www-Authenticate Header: ${authenticateStr}`);
  }
  return {
    realm: matches[0],
    service: matches[1],
  };
}

async function fetchToken(wwwAuthenticate, scope, authorization) {
  const url = new URL(wwwAuthenticate.realm);
  if (wwwAuthenticate.service.length) {
    url.searchParams.set("service", wwwAuthenticate.service);
  }
  if (scope) {
    url.searchParams.set("scope", scope);
  }
  const headers = new Headers();
  if (authorization) {
    headers.set("Authorization", authorization);
  }
  return await fetch(url, { method: "GET", headers: headers });
}

function responseUnauthorized(url) {
  const headers = new Headers();
  if (RUNTIME_MODE === "debug") {
    headers.set(
      "Www-Authenticate",
      `Bearer realm="http://${url.host}/v2/auth",service="cloudflare-docker-proxy"`
    );
  } else {
    headers.set(
      "Www-Authenticate",
      `Bearer realm="https://${url.hostname}/v2/auth",service="cloudflare-docker-proxy"`
    );
  }
  // 用 Registry 规范的标准错误信封，而不是自造的 {"message":"UNAUTHORIZED"}。
  // 真实 registry-1.docker.io 的 401 长这样（2026-09-25 实测对照）：
  //   Content-Type: application/json
  //   docker-distribution-api-version: registry/2.0
  //   {"errors":[{"code":"UNAUTHORIZED","message":"authentication required","detail":null}]}
  // docker CLI / Portainer 等客户端按 `errors[].code` 解析错误，格式不对会误报。
  // （注：群晖 Container Manager 不解析 401 body，它靠的是上面的「服务端匿名换票」。）
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("docker-distribution-api-version", "registry/2.0");
  return new Response(
    JSON.stringify({
      errors: [
        {
          code: "UNAUTHORIZED",
          message: "authentication required",
          detail: null,
        },
      ],
    }),
    {
      status: 401,
      headers: headers,
    }
  );
}
