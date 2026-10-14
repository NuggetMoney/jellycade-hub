import assert from "node:assert/strict";
import fs from "node:fs";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import test from "node:test";
import jellycade from "../api/jellycade.js";

const previewHost = "jellycade-n77en68pz-nuggetmoney.vercel.app";
const previewOrigin = `https://${previewHost}`;

function makeRequest({
  method,
  path,
  origin = previewOrigin,
  headers = {},
  body,
  host = previewHost,
}) {
  return {
    method,
    query: { __path: path },
    headers: { host, ...(origin ? { origin } : {}), ...headers },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body);
    },
  };
}

function makeResponse() {
  const response = new Writable({
    write(chunk, _encoding, callback) {
      this.chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  response.chunks = [];
  response.headers = {};
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.setHeader = (name, value) => {
    response.headers[name.toLowerCase()] = value;
  };
  response.send = (body) => {
    response.end(body);
    return response;
  };
  response.json = (body) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
    return response;
  };
  response.bodyText = () => Buffer.concat(response.chunks).toString("utf8");
  return response;
}

test("same-origin presence write is forwarded with the real Origin", async () => {
  const originalFetch = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (url, options) => {
    forwarded = { url: String(url), options };
    return new Response(null, { status: 204 });
  };
  try {
    const response = makeResponse();
    await jellycade(
      makeRequest({
        method: "POST",
        path: "/api/presence/heartbeat",
        headers: { "content-type": "application/json" },
        body: '{"state":"active"}',
      }),
      response,
    );
    await finished(response);

    assert.equal(response.statusCode, 204);
    assert.equal(forwarded.url, "https://jellycade.com/api/presence/heartbeat");
    assert.equal(forwarded.options.method, "POST");
    assert.equal(forwarded.options.headers.get("origin"), previewOrigin);
    assert.equal(forwarded.options.body.toString(), '{"state":"active"}');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("same-origin localhost presence writes use the local HTTP origin", async () => {
  const originalFetch = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (url, options) => {
    forwarded = { url: String(url), options };
    return new Response(null, { status: 204 });
  };
  try {
    const response = makeResponse();
    await jellycade(
      makeRequest({
        method: "POST",
        path: "/api/presence/heartbeat",
        host: "localhost:3000",
        origin: "http://localhost:3000",
        headers: { "x-forwarded-proto": "http" },
        body: "{}",
      }),
      response,
    );
    await finished(response);

    assert.equal(response.statusCode, 204);
    assert.equal(forwarded.options.headers.get("origin"), "http://localhost:3000");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cross-origin heartbeat is rejected locally before forwarding", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let fetchCalled = false;
  const logs = [];
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("cross-origin request must not reach upstream");
  };
  console.warn = (...args) => logs.push(args);
  try {
    const response = makeResponse();
    await jellycade(
      makeRequest({
        method: "POST",
        path: "/api/presence/heartbeat",
        origin: "https://untrusted.example",
        body: "{}",
      }),
      response,
    );
    await finished(response);

    assert.equal(response.statusCode, 403);
    assert.deepEqual(JSON.parse(response.bodyText()), {
      error: "Cross-origin presence write blocked by Jellycade Hub proxy.",
    });
    assert.equal(fetchCalled, false);
    assert.deepEqual(logs[0], ["[jellycade-proxy] local origin check rejected presence write", {
      method: "POST",
      route: "presence-heartbeat",
      originPresent: true,
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("same-origin heartbeat upstream 403 is distinguishable from local rejection", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const logs = [];
  let forwardedOrigin;
  globalThis.fetch = async (_url, options) => {
    forwardedOrigin = options.headers.get("origin");
    return new Response('{"message":"cross-origin presence write"}', {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  console.warn = (...args) => logs.push(args);
  try {
    const response = makeResponse();
    await jellycade(
      makeRequest({
        method: "POST",
        path: "/api/presence/heartbeat",
        body: '{"state":"active"}',
      }),
      response,
    );
    await finished(response);

    assert.equal(forwardedOrigin, previewOrigin);
    assert.equal(response.statusCode, 403);
    assert.equal(response.bodyText(), '{"message":"cross-origin presence write"}');
    assert.deepEqual(logs[0], ["[jellycade-proxy] upstream 403", {
      method: "POST",
      upstreamHost: "jellycade.com",
      route: "presence-heartbeat",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("Cloudflare text 403 from same-origin heartbeat is forwarded with its trace header", async () => {
  const originalFetch = globalThis.fetch;
  let forwardedUrl;
  globalThis.fetch = async (url, options) => {
    forwardedUrl = String(url);
    assert.equal(options.headers.get("origin"), previewOrigin);
    return new Response("cross-origin presence write", {
      status: 403,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cf-ray": "a4aa55cbdf5a7d61-IAD",
      },
    });
  };
  try {
    const response = makeResponse();
    await jellycade(
      makeRequest({
        method: "POST",
        path: "/api/presence/heartbeat",
        headers: { "content-type": "application/json" },
        body: '{"slug":"rocket-bot-royale","state":"active"}',
      }),
      response,
    );
    await finished(response);

    assert.equal(forwardedUrl, "https://jellycade.com/api/presence/heartbeat");
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(response.headers["cf-ray"], "a4aa55cbdf5a7d61-IAD");
    assert.equal(response.bodyText(), "cross-origin presence write");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upstream presence 403 is forwarded and logs no request secrets", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let forwarded;
  const logs = [];
  globalThis.fetch = async (url, options) => {
    forwarded = { url: String(url), options };
    return new Response('{"message":"cross-origin presence write"}', {
      status: 403,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-upstream-marker": "mock-upstream",
      },
    });
  };
  console.warn = (...args) => logs.push(args);
  try {
    const response = makeResponse();
    await jellycade(
      makeRequest({
        method: "POST",
        path: "/api/presence/end",
        headers: {
          "content-type": "application/json",
          cookie: "test-cookie-secret",
          authorization: "Bearer test-token-secret",
        },
        body: '{"private":"test-body-secret"}',
      }),
      response,
    );
    await finished(response);

    assert.equal(forwarded.url, "https://jellycade.com/api/presence/end");
    assert.equal(forwarded.options.headers.get("origin"), previewOrigin);
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(response.headers["x-upstream-marker"], "mock-upstream");
    assert.equal(response.bodyText(), '{"message":"cross-origin presence write"}');
    const logText = JSON.stringify(logs);
    for (const secret of ["test-cookie-secret", "test-token-secret", "test-body-secret"]) {
      assert.equal(logText.includes(secret), false);
    }
    assert.deepEqual(logs[0], ["[jellycade-proxy] upstream 403", {
      method: "POST",
      upstreamHost: "jellycade.com",
      route: "presence-end",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("upstream catalog and game API 403s are labeled without logging URL data", async (t) => {
  for (const [path, expectedRoute] of [
    ["/api/catalog.json", "catalog"],
    ["/api/matchmaking/join", "jellycade-api"],
  ]) {
    await t.test(path, async () => {
      const originalFetch = globalThis.fetch;
      const originalWarn = console.warn;
      const logs = [];
      globalThis.fetch = async () => new Response("denied", { status: 403 });
      console.warn = (...args) => logs.push(args);
      try {
        const response = makeResponse();
        await jellycade(
          makeRequest({
            method: "GET",
            path,
            headers: { cookie: "must-not-be-logged" },
          }),
          response,
        );
        await finished(response);

        assert.equal(response.statusCode, 403);
        assert.equal(logs[0][1].route, expectedRoute);
        assert.equal(JSON.stringify(logs).includes("must-not-be-logged"), false);
      } finally {
        globalThis.fetch = originalFetch;
        console.warn = originalWarn;
      }
    });
  }
});

test("audio worklet has a specific rewrite before the generic host route", async () => {
  const config = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const assetRule = config.rewrites.findIndex((rule) => rule.source === "/_proxy/index.audio.worklet.js");
  const genericRule = config.rewrites.findIndex((rule) => rule.source === "/_proxy/:host");
  assert.ok(assetRule >= 0 && assetRule < genericRule);

  const originalFetch = globalThis.fetch;
  let upstreamUrl;
  globalThis.fetch = async (url) => {
    upstreamUrl = String(url);
    return new Response("self.audioWorklet", {
      status: 200,
      headers: { "content-type": "text/javascript" },
    });
  };
  try {
    const response = makeResponse();
    await jellycade(
      makeRequest({
        method: "GET",
        path: "/_proxy/index.audio.worklet.js",
        headers: { referer: `${previewOrigin}/en/games/rocket-bot-royale` },
      }),
      response,
    );
    await finished(response);

    assert.equal(
      upstreamUrl,
      "https://01a05b8d-9300-73d9-884f-d36df191f6c3.jellycade-cdn.com/index.audio.worklet.js",
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "text/javascript");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
