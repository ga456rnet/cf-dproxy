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
    const nRaw = parseInt(url.searchParams.get("n") || "25", 10);
    const n = Number.isFinite(nRaw) ? Math.min(Math.max(nRaw, 1), 100) : 25;
    const pageRaw = parseInt(url.searchParams.get("page") || "1", 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    // ?debug=1 —— 把上游诊断信息带进响应，便于排查"搜索返回 0 条"
    const debug = url.searchParams.get("debug") === "1";
    const diag = { attempts: [], resolvedBy: null };

    let results = null;
    let total = 0;

    // 只有 Docker Hub 有公开搜索 API。其他上游（ghcr/quay/gcr/ecr...）
    // 一律返回空结果 —— 让 UI 显示"无结果"，而不是"查询注册表失败"。
    if (q && isDockerHub) {
      // ---- 1) 依次尝试各搜索上游 ----
      const qs = `?query=${encodeURIComponent(q)}&page_size=${n}&page=${page}`;
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
        const candidates = q.includes("/") ? [q] : ["library/" + q, q];
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
  const resp = await fetch(newReq);
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
async function probeRepoName(name) {
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
  const r = await fetch(`${base}/v2/${name}/tags/list?n=10`, {
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
  return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
    status: 401,
    headers: headers,
  });
}
