import { buildSync } from "esbuild";
import { writeFileSync } from "node:fs";

// The scaffold otherwise fetches browser Chai from the web during tests.
buildSync({
  entryPoints: ["node_modules/chai/index.js"],
  bundle: true,
  format: "iife",
  globalName: "chai",
  target: "firefox140",
  outfile: ".scaffold/cache/chai.js",
  logLevel: "error",
});
writeFileSync(".scaffold/cache/test-node-path.json", JSON.stringify(process.execPath));
