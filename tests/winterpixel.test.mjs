import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import test from "node:test";
import winterpixel from "../api/winterpixel.js";

const previewOrigin = "https://jellycade-k09xd1ewj-nuggetmoney.vercel.app";

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
  response.json = (body) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
    return response;
  };
  response.bodyText = () => Buffer.concat(response.chunks).toString("utf8");
  return response;
}

function makeRequest({ origin = previewOrigin, method = "GET" } = {}) {
  return {
    method,
    headers: { host: new URL(previewOrigin).host, origin },
  };
}

test("Preview origin can use the read-only Winterpixel diagnostic", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok", { status: 200 });
  try {
    const response = makeResponse();
    await winterpixel(makeRequest(), response);
    await finished(response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["access-control-allow-origin"], previewOrigin);
    assert.deepEqual(JSON.parse(response.bodyText()), {
      diagnostic: "Upstream root responded successfully",
      upstreamStatus: 200,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("diagnostic preserves an upstream error instead of reporting success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("forbidden", { status: 403 });
  try {
    const response = makeResponse();
    await winterpixel(makeRequest(), response);
    await finished(response);

    assert.equal(response.statusCode, 403);
    assert.deepEqual(JSON.parse(response.bodyText()), {
      diagnostic: "Upstream root returned an error",
      upstreamStatus: 403,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cross-origin requests to the diagnostic are rejected locally", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response("unexpected", { status: 200 });
  };
  try {
    const response = makeResponse();
    await winterpixel(
      makeRequest({ origin: "https://untrusted.example" }),
      response,
    );
    await finished(response);

    assert.equal(response.statusCode, 403);
    assert.deepEqual(JSON.parse(response.bodyText()), { error: "Origin not allowed" });
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
