// Reviewed local mitigation for GHSA-gcqx-w48m-w2h4. Upstream has no patched
// release. Keep the actual package version so npm audit still reports it.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const directory = path.dirname(require.resolve("deepmerge/package.json"));
const version = require("deepmerge/package.json").version;
if (version !== "4.3.1") throw new Error("Review deepmerge mitigation for version " + version);
const marker = "// RMS: reject prototype-control keys on both merge inputs.";
for (const file of ["dist/cjs.js", "dist/umd.js", "index.js"]) {
  const target = path.join(directory, file);
  let text = fs.readFileSync(target, "utf8");
  if (!text.includes(marker)) {
    const original = "function getKeys(target) {";
    if (!text.includes(original)) throw new Error("Unexpected deepmerge source layout: " + file);
    text = text.replace(original, `${original}\n\t${marker}\n\tvar safe = function(key) { return key !== '__proto__' && key !== 'constructor' && key !== 'prototype'; };`);
    const keys = "return Object.keys(target).concat(getEnumerableOwnPropertySymbols(target))";
    if (!text.includes(keys)) throw new Error("Unexpected deepmerge key enumeration: " + file);
    text = text.replace(keys, keys + ".filter(safe)");
    fs.writeFileSync(target, text);
  }
}
const merge = require("deepmerge");
const poison = JSON.parse('{"__proto__":{"poisoned":true},"constructor":{"prototype":{"poisoned":true}},"valid":{"value":2}}');
for (const [target, source] of [[{}, poison], [poison, {}], [Object.create(null), poison]]) {
  const result = merge(target, source);
  assert.strictEqual(Object.getPrototypeOf(result), Object.prototype);
  assert.strictEqual(result.poisoned, undefined);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result, "__proto__"), false);
}
assert.deepStrictEqual(merge({ valid: { original: 1 } }, poison).valid, { original: 1, value: 2 });
assert.deepStrictEqual(merge({ array: [1] }, { array: [2] }), { array: [1, 2] });
console.log("deepmerge 4.3.1 prototype-key mitigation verified (npm advisory remains visible).");
