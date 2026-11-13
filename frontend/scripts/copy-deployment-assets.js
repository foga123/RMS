/**
 * Copy frontend/assets into the build, at build/frontend/assets.
 *
 * getAssetUrl() (src/shared/lib/url.js) resolves "assets/coc.png" to
 * "/frontend/assets/coc.png" when the page is not under a /capstone2.0/ prefix.
 * Apache serves that path from the source folder (XAMPP, and the Docker vhost's
 * Alias), but Vercel serves only the build output, so without this copy the
 * logos on the login page are 404s there.
 *
 * Run by the Vercel build command in vercel.json only. A local `npm run build`
 * does not need it and does not run it.
 */
const fs = require("fs");
const path = require("path");

const frontendRoot = path.resolve(__dirname, "..");
const source = path.join(frontendRoot, "assets");
const destination = path.join(frontendRoot, "build", "frontend", "assets");

fs.mkdirSync(destination, { recursive: true });
fs.cpSync(source, destination, { recursive: true });
console.log(`copied ${source} -> ${destination}`);
