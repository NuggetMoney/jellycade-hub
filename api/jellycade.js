
import { Readable } from "node:stream";

const MAIN_HOSTS = new Set([
  "jellycade.com",
  "www.jellycade.com",
]);

function allowedHost(host) {
  if (typeof host !== "string") return false;
  host = host.toLowerCase().replace(/\.$/, "");

  return (
    MAIN_HOSTS.has(host) ||
    host.endsWith(".jellycade.com") ||
    host === "jellycade-cdn.com" ||
    host.endsWith(".jellycade-cdn.com")
  );
}

function isMainHost(host) {
  return MAIN_HOSTS.has(host.toLowerCase());
}

function getValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function proxyPath(target, origin) {
  if (isMainHost(target.hostname)) {
    return target.pathname + target.search + target.hash;
  }

  return (
    "/_proxy/" +
    target.hostname.toLowerCase() +
    (target.pathname.startsWith("/") ? target.pathname : "/" + target.pathname) +
    target.search +
    target.hash
  );
}

function rewriteAbsoluteUrls(text, origin) {
  const pattern =
    /(https?:\/\/|wss?:\/\/|ws:\/\/|\/\/)((?:[a-z0-9-]+\.)*(?:jellycade\.com|jellycade-cdn\.com))(?=[:/?#"'`\s]|$)/gi;

  const proxy = new URL(origin);

  return text.replace(pattern, (_match, scheme, rawHost) => {
    const host = rawHost.toLowerCase();

    if (scheme.toLowerCase().startsWith("ws")) {
      const wsScheme =
        proxy.protocol === "https:" ? "wss://" : "ws://";

      return (
        wsScheme +
        proxy.host +
        (isMainHost(host) ? "" : "/_proxy/" + host)
      );
    }

    return origin + (isMainHost(host) ? "" : "/_proxy/" + host);
  });
}

function rewriteCsp(value, origin) {
  const proxy = new URL(origin);

  return value.replace(
    /(https?:\/\/|wss?:\/\/|ws:\/\/)(?:\*\.)?((?:[a-z0-9-]+\.)*(?:jellycade\.com|jellycade-cdn\.com))/gi,
    (_match, scheme) => {
      if (scheme.toLowerCase().startsWith("ws")) {
        return (proxy.protocol === "https:" ? "wss://" : "ws://") +
          proxy.host;
      }

      return origin;
    }
  );
}

function rewriteHtml(html, destination, origin) {
  return html.replace(
    /\b(href|src|action|poster|data|formaction)\s*=\s*(["'])(.*?)\2/gi,
    (match, attribute, quote, value) => {
      try {
        const target = new URL(value, destination);

        if (
          target.protocol !== "http:" &&
          target.protocol !== "https:"
        ) {
          return match;
        }

        if (!allowedHost(target.hostname)) return match;

        const mapped = proxyPath(target, origin);
        return `${attribute}=${quote}${mapped}${quote}`;
      } catch {
        return match;
      }
    }
  );
}

function getCdnFromReferer(req, origin) {
  try {
    const referer = req.headers.referer;
    if (!referer) return null;

    const ref = new URL(referer);
    if (ref.origin !== origin) return null;

    const match = ref.pathname.match(/^\/_proxy\/([^/]+)(?:\/|$)/);
    if (!match) return null;

    const host = decodeURIComponent(match[1]).toLowerCase();

    return allowedHost(host) && !isMainHost(host) ? host : null;
  } catch {
    return null;
  }
}

async function readBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  const origin = `https://${req.headers.host}`;

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
    res.setHeader("Vary", "Origin");
    return res.status(204).end();
  }

  let incomingPath = getValue(req.query.__path)
    ?? getValue(req.query.path)
    ?? "/en";

  let host = String(
    getValue(req.query.__host) || "jellycade.com"
  ).toLowerCase();

  let path = String(incomingPath);
  const cdnFromReferer = getCdnFromReferer(req, origin);
const rbrCdnHost =
  "01a05b8d-9300-73d9-884f-d36df191f6c3.jellycade-cdn.com";
  // Route proxy URLs only to approved Jellycade hosts.
  if (path.startsWith("/_proxy/")) {
    const rest = path.slice("/_proxy/".length);
    const slash = rest.indexOf("/");
    const candidate = (
      slash === -1 ? rest : rest.slice(0, slash)
    ).toLowerCase();

    if (allowedHost(candidate)) {
      host = candidate;
      path = slash === -1 ? "/" : rest.slice(slash);
    } else if (
  !req.query.__host &&
  (cdnFromReferer || rbrCdnHost)
) {
  // Route RBR's legacy game-file paths to its known CDN.
  host = cdnFromReferer || rbrCdnHost;
  path = "/" + rest;
} else {
      return res.status(403).send("Blocked: unsupported Jellycade host.");
    }
  } else if (cdnFromReferer && !req.query.__host) {
    host = cdnFromReferer;
  }

  if (!allowedHost(host)) {
    return res.status(403).send("Blocked: unsupported Jellycade host.");
  }

  if (!path.startsWith("/")) path = "/" + path;

  const destination = new URL("https://" + host);
  destination.pathname = path;

  const search = new URLSearchParams();

  for (const [key, rawValue] of Object.entries(req.query)) {
    if (key === "__host" || key === "__path") continue;

    const values = Array.isArray(rawValue) ? rawValue : [rawValue];

    for (const value of values) {
      if (value !== undefined && value !== null) {
        search.append(key, String(value));
      }
    }
  }

  destination.search = search.toString()
    ? "?" + search.toString()
    : "";

  const headers = new Headers();

  for (const [name, rawValue] of Object.entries(req.headers)) {
    if (rawValue === undefined || Array.isArray(rawValue)) continue;

    const lower = name.toLowerCase();

    if ([
      "host",
      "connection",
      "content-length",
      "cf-connecting-ip",
      "cf-ray",
      "x-forwarded-for",
      "accept-encoding",
    ].includes(lower)) {
      continue;
    }

    headers.set(name, String(rawValue));
  }

  headers.set("accept-encoding", "identity");

  // Never forward site credentials to a separate CDN.
  if (!isMainHost(host)) {
    headers.delete("cookie");
    headers.delete("authorization");
  }

  if (headers.get("origin") === origin) {
    headers.set("origin", "https://jellycade.com");
  }

  const referer = headers.get("referer");

  if (referer) {
    try {
      const ref = new URL(referer);

      if (ref.origin === origin) {
        headers.set(
          "referer",
          cdnFromReferer
            ? `https://${cdnFromReferer}/`
            : `https://jellycade.com${ref.pathname}${ref.search}`
        );
      }
    } catch {
      headers.delete("referer");
    }
  }

  let body;

  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await readBody(req);
  }

  let upstream;

  try {
    upstream = await fetch(destination, {
      method: req.method,
      headers,
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : body,
      redirect: "manual",
    });
  } catch {
    return res.status(502).send("Could not connect to Jellycade.");
  }

  const outHeaders = new Headers(upstream.headers);
  const contentType = outHeaders.get("content-type") || "";

  const location = outHeaders.get("location");

  if (location) {
    try {
      const target = new URL(location, destination);

      if (allowedHost(target.hostname)) {
        outHeaders.set("location", proxyPath(target, origin));
      }
    } catch {
      // Keep unrelated redirects unchanged.
    }
  }

  if (!isMainHost(host)) {
    outHeaders.delete("set-cookie");
  } else if (typeof outHeaders.getSetCookie === "function") {
    const cookies = outHeaders.getSetCookie();
    outHeaders.delete("set-cookie");

    for (const cookie of cookies) {
      outHeaders.append(
        "set-cookie",
        cookie.replace(/;\s*domain=[^;]+/ig, "")
      );
    }
  }

  for (const name of [
    "content-security-policy",
    "content-security-policy-report-only",
  ]) {
    const policy = outHeaders.get(name);

    if (policy) {
      let value = rewriteCsp(policy, origin);

      if (!isMainHost(host) && contentType.includes("text/html")) {
        value = value
          .split(";")
          .map(part => part.trim())
          .filter(part => !/^frame-ancestors(?:\s|$)/i.test(part))
          .join("; ");
      }

      if (value) outHeaders.set(name, value);
      else outHeaders.delete(name);
    }
  }

  if (!isMainHost(host) && contentType.includes("text/html")) {
    outHeaders.delete("x-frame-options");
  }

  if (
    req.method === "HEAD" ||
    upstream.status === 204 ||
    upstream.status === 304
  ) {
    res.status(upstream.status);

    for (const [name, value] of outHeaders) {
      res.setHeader(name, value);
    }

    return res.end();
  }

  if (
    /text\/html|javascript|ecmascript|text\/css|application\/json|application\/manifest\+json/i
      .test(contentType)
  ) {
    let text;

    try {
      text = await upstream.text();
    } catch {
      return res.status(502).send("Could not read Jellycade response.");
    }

    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    outHeaders.delete("etag");

    if (contentType.includes("text/html")) {
      text = rewriteHtml(text, destination, origin);
    }

    text = rewriteAbsoluteUrls(text, origin);

    res.status(upstream.status);

    for (const [name, value] of outHeaders) {
      res.setHeader(name, value);
    }

    return res.send(text);
  }

  res.status(upstream.status);

  for (const [name, value] of outHeaders) {
    res.setHeader(name, value);
  }

  if (!upstream.body) return res.end();

  return Readable.fromWeb(upstream.body).pipe(res);
}
