import assert from "node:assert/strict";
import fs from "node:fs";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import test from "node:test";
import jellycade from "../api/jellycade.js";

const previewHost = "jellycade-fcntz1fb0-nuggetmoney.vercel.app";
const previewOrigin = `https://${previewHost}`;

function makeRequest({ method, path, origin = previewOrigin, headers = {}, body }) {
  return {
    method,
    query: { __path: path },
    headers: { host: previewHost, ...(origin ? { origin } : {}), ...headers },
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

test("cross-origin presence write is rejected before forwarding", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("cross-origin request must not reach upstream");
  };
  try {
    const response = makeResponse();
    await jellycade(
      makeRequest({
        method: "POST",
        path: "/api/presence/end",
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
