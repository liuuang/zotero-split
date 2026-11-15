import "./prepare-zotero-test.mjs";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const logDir = ".scaffold/logs";
mkdirSync(logDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(":", "-");
const logPath = join(logDir, `zotero-smoke-${stamp}.log`);
const localRgXpi = resolve("..", "researchgraph", ".scaffold", "build", "research-graph-for-zotero.xpi");
const rgXpiPath = process.env.RG_XPI_PATH || (existsSync(localRgXpi) ? localRgXpi : "");
writeFileSync("test/zotero/rg-path.generated.ts", `export const rgXpiPath = ${JSON.stringify(rgXpiPath)};\n`);
const command = join("node_modules", "zotero-plugin-scaffold", "bin", "zotero-plugin.mjs");
const child = spawn(process.execPath, [command, "test", "--exit-on-finish"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});
let log = "";
const capture = (stream, output) => stream.on("data", (chunk) => {
  const text = chunk.toString();
  log += text;
  output.write(text);
});
capture(child.stdout, process.stdout);
capture(child.stderr, process.stderr);

const timeout = setTimeout(() => {
  const message = "\nZotero smoke timed out after 180 seconds.\n";
  log += message;
  process.stderr.write(message);
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  } else {
    child.kill("SIGKILL");
  }
}, 180_000);

child.on("close", (code) => {
  clearTimeout(timeout);
  writeFileSync(logPath, log);
  process.stdout.write(`Full Zotero test log: ${logPath}\n`);
  process.exitCode = code ?? 1;
});
