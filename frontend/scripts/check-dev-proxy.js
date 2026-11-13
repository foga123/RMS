// Real HTTP regression for the development proxy; no database or email calls.
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
const expectedPath = (path) => path.replace(/^\/RMS-v3-public\/frontend\/backend/, "/RMS-v3-public/backend");

(async () => {
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Set-Cookie", "rms_probe=ok; HttpOnly; SameSite=Strict; Path=/");
    res.end(JSON.stringify({ url: req.url, method: req.method, cookie: req.headers.cookie, body }));
  });
  await listen(upstream);
  const previousTarget = process.env.PROXY_TARGET;
  process.env.PROXY_TARGET = `http://127.0.0.1:${upstream.address().port}`;
  const app = express();
  require("../src/setupProxy")(app);
  app.use((req, res) => res.status(404).end("not proxied"));
  const server = http.createServer(app);
  await listen(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of [
      "/RMS-v3-public/frontend/backend/api/captcha_policy.php?probe=1",
      "/RMS-v3-public/frontend/assets/Login%20Logo%20Left.png",
      "/RMS-v3-public/frontend/assets/phinma-logo.png",
    ]) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).url, expectedPath(path));
    }
    const response = await fetch(origin + "/RMS-v3-public/frontend/backend/api/refresh.php", {
      method: "POST", headers: { Cookie: "rms_probe=incoming", "Content-Type": "application/json" },
      body: JSON.stringify({ probe: true }),
    });
    const result = await response.json();
    assert.equal(result.url, expectedPath("/RMS-v3-public/frontend/backend/api/refresh.php"));
    assert.equal(result.method, "POST");
    assert.equal(result.cookie, "rms_probe=incoming");
    assert.equal(result.body, '{"probe":true}');
    assert.match(response.headers.get("set-cookie"), /rms_probe=ok/);
    assert.equal((await fetch(origin + "/RMS-v3-public-other/file")).status, 404);
    await close(upstream);
    const unavailable = await fetch(origin + "/RMS-v3-public/frontend/backend/api/captcha_policy.php");
    assert.equal(unavailable.status, 502);
    assert.match((await unavailable.json()).message, /could not reach Apache/);
    console.log("PASS development proxy: paths, query, POST body, cookies, filter boundary, JSON 502");
  } finally {
    await close(server);
    if (upstream.listening) await close(upstream);
    if (previousTarget === undefined) delete process.env.PROXY_TARGET;
    else process.env.PROXY_TARGET = previousTarget;
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
