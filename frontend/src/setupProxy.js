/** Forward development API and asset requests to Apache on the same origin. */
const { createProxyMiddleware } = require("http-proxy-middleware");

// IPv4 avoids XAMPP installations that do not listen on localhost's ::1.
const APACHE = process.env.PROXY_TARGET || "http://127.0.0.1:80";

module.exports = function setupProxy(app) {
  // Do not mount at /capstone2.0: Express strips mount paths before HPM sees
  // them. Keep the original URL so Apache receives the actual checkout path.
  app.use(
    createProxyMiddleware({
      pathFilter: (path) => path === "/RMS-v3-public" || path.startsWith("/RMS-v3-public/"),
      target: APACHE,
      changeOrigin: true,
      pathRewrite: { "^/RMS-v3-public/frontend/backend": "/RMS-v3-public/backend" },
      on: {
        error(err, req, res) {
          if (res.headersSent) return;
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            message: "The dev server could not reach Apache at " + APACHE +
              ". Start Apache in the XAMPP control panel.",
            error: err.message,
          }));
        },
      },
    })
  );
};
