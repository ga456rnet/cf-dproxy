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
// 【临时诊断】请求记录器
// 把最近收到的请求写进 Cloudflare 边缘缓存（caches.default），
// 通过 GET /__reqlog 读回。用于确认"DSM 搜索到底发了什么请求"。
// 定位完问题后把 REQLOG_ENABLED 改成 false 或整段删掉即可。
// ---------------------------------------------------------------------------
const REQLOG_ENABLED = true;
const REQLOG_KEY_URL = "https://docker.aburling.dpdns.org/__reqlog";
const REQLOG_MAX = 20;

async function recordRequest(request, url) {
  try {
    const entry = {
      at: new Date().toISOString(),
      method: request.method,
      path: url.pathname,
      query: url.search,
      ua: (request.headers.get("user-agent") || "").slice(0, 160),
      accept: (request.headers.get("accept") || "").slice(0, 80),
      hasAuth: !!request.headers.get("authorization"),
      colo: (request.cf && request.cf.colo) || "",
      country: (request.cf && request.cf.country) || "",
    };
    const key = new Request(REQLOG_KEY_URL, { method: "GET" });
    let list = [];
    const hit = await caches.default.match(key);
    if (hit) {
      try {
        list = await hit.json();
      } catch (e) {
        list = [];
      }
      if (!Array.isArray(list)) list = [];
    }
    list.unshift(entry);
    if (list.length > REQLOG_MAX) list = list.slice(0, REQLOG_MAX);
    await caches.default.put(
      key,
      new Response(JSON.stringify(list), {
        headers: {
          "content-type": "application/json",
          "cache-control": "max-age=600",
        },
      })
    );
  } catch (e) {
    // 记录失败绝不能影响主流程
  }
}


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

const routes = {
  // production
  ["docker.aburling.dpdns.org"]: dockerHub,
  ["quay.aburling.dpdns.org"]: "https://quay.io",
  ["gcr.aburling.dpdns.org"]: "https://gcr.io",
  ["k8s-gcr.aburling.dpdns.org"]: "https://k8s.gcr.io",
  ["k8s.aburling.dpdns.org"]: "https://registry.k8s.io",
  ["ghcr.aburling.dpdns.org"]: "https://ghcr.io",
  ["cloudsmith.aburling.dpdns.org"]: "https://docker.cloudsmith.io",
  ["ecr.aburling.dpdns.org"]: "https://public.ecr.aws",

  // staging
  ["docker-staging.aburling.dpdns.org"]: dockerHub,
};

function routeByHosts(host) {
  if (host in routes) {
    return routes[host];
  }
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

  // ---------------------------------------------------------------------------
  // 请求记录读回接口 —— 【临时诊断用，定位完问题就删】
  // 用途：DSM 搜索到底发了什么请求、打到哪个路径、带什么参数，只有 Worker 自己知道。
  //      把最近 20 条请求记到边缘缓存，再用 GET /__reqlog 读回来。
  // ---------------------------------------------------------------------------
  if (url.pathname === "/__reqlog") {
    const hit = await caches.default.match(
      new Request(REQLOG_KEY_URL, { method: "GET" })
    );
    const body = hit ? await hit.text() : "[]";
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  // /blobs/ 是 pull 热路径，跳过记录以免拖慢镜像下载
  if (REQLOG_ENABLED && !url.pathname.includes("/blobs/")) {
    const p = recordRequest(request, url);
    if (event && typeof event.waitUntil === "function") {
      event.waitUntil(p);
    }
  }

  if (url.pathname == "/") {
    return Response.redirect(url.protocol + "//" + url.host + "/v2/", 301);
  }
  const upstream = routeByHosts(url.hostname);
  if (upstream === "") {
    // 主机名不在 routes 表里 —— 这就是"自定义域 404"的来源
    return new Response(
      JSON.stringify(
        {
          error: "HOST_NOT_CONFIGURED",
          message:
            "该主机名不在 Worker 的 routes 表中。请把自定义域的主机名加入 src/index.js 的 routes，" +
            "或在 wrangler.toml 里为它配置 route/custom_domain。",
          receivedHost: url.hostname,
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
  const authorization = request.headers.get("Authorization");

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
    let tags = null;
    try {
      const info = await probeRepoName(rawName, 100);
      if (info.exists && Array.isArray(info.tags)) tags = info.tags;
    } catch (e) {
      /* 吞掉 —— 兜底接口不能把请求变成 500 */
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
  // redirect for DockerHub library images
  // Example: /v2/busybox/manifests/latest => /v2/library/busybox/manifests/latest
  if (isDockerHub) {
    const pathParts = url.pathname.split("/");
    if (pathParts.length == 5) {
      pathParts.splice(2, 0, "library");
      const redirectUrl = new URL(url);
      redirectUrl.pathname = pathParts.join("/");
      return Response.redirect(redirectUrl, 301);
    }
  }
  // foward requests
  const newUrl = new URL(upstream + url.pathname);
  const newReq = new Request(newUrl, {
    method: request.method,
    headers: request.headers,
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
