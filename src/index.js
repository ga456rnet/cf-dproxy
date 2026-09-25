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
 * 兼容性：本文件仍使用 Service Worker 语法（addEventListener），
 * 与仓库现有 wrangler.toml（无 main 字段、compatibility_date = 2023-12-01）保持一致，
 * 部署命令无需改动。
 */

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

const dockerHub = "https://registry-1.docker.io";

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
async function handleRequest(request) {
  try {
    return await handleRequestInner(request);
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

async function handleRequestInner(request) {
  const url = new URL(request.url);
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
