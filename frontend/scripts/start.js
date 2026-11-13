// CRA's compiler remains unchanged. Adapt only its removed dev-server options.
process.env.NODE_ENV = "development";
process.env.BABEL_ENV = "development";
process.env.HOST = process.env.HOST || "127.0.0.1";
require("react-scripts/config/env");
const webpackPath = require.resolve("react-scripts/config/webpack.config");
const webpackFactory = require(webpackPath);
require.cache[webpackPath].exports = (environment) => {
  const config = webpackFactory(environment);
  // CRA's catch-all asset rule predates .cjs; WDS 6's logger uses it.
  for (const rule of config.module.rules) {
    if (rule.oneOf) rule.oneOf.unshift({ test: /\.cjs$/, type: "javascript/auto" });
  }
  return config;
};
const DevServer = require("webpack-dev-server");
// CRA's signal handler still uses the old shutdown method name.
if (!DevServer.prototype.close) DevServer.prototype.close = DevServer.prototype.stopCallback;
const fs = require("fs");
const paths = require("react-scripts/config/paths");
const configPath = require.resolve("react-scripts/config/webpackDevServer.config");
const legacyFactory = require(configPath);
require.cache[configPath].exports = (proxy, allowedHost) => {
  const legacy = legacyFactory(proxy, allowedHost);
  const { https, onBeforeSetupMiddleware, onAfterSetupMiddleware, ...config } = legacy;
  // Explicit opt-in for remote development, never an unrestricted host check.
  config.allowedHosts = (process.env.RMS_DEV_ALLOWED_HOSTS || "localhost,127.0.0.1,.localhost").split(",").map((host) => host.trim()).filter(Boolean);
  config.headers = {};
  config.server = https ? { type: "https", options: typeof https === "object" ? https : {} } : "http";
  if (!config.proxy) delete config.proxy;
  config.devMiddleware.publicPath = paths.publicUrlOrPath;
  config.setupMiddlewares = (middlewares, server) => {
    if (fs.existsSync(paths.proxySetup)) require(paths.proxySetup)(server.app);
    middlewares.unshift({ name: "cra-source-map", middleware: require("react-dev-utils/evalSourceMapMiddleware")(server) });
    middlewares.push(
      { name: "cra-public-path", middleware: require("react-dev-utils/redirectServedPathMiddleware")(paths.publicUrlOrPath) },
      { name: "cra-noop-worker", middleware: require("react-dev-utils/noopServiceWorkerMiddleware")(paths.publicUrlOrPath) }
    );
    return middlewares;
  };
  return config;
};
require("react-scripts/scripts/start");
