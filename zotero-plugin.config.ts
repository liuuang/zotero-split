import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: "https://github.com/liuuang/zotero-split/releases/latest/download/update.json",
  xpiDownloadLink: "https://github.com/liuuang/zotero-split/releases/download/v{{version}}/{{xpiName}}.xpi",
  build: {
    assets: ["addon/**/*.*", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}"
    },
    prefs: { prefix: pkg.config.prefsPrefix },
    esbuildOptions: [{
      entryPoints: ["src/index.ts"],
      bundle: true,
      target: "firefox140",
      outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`
    }]
  },
  test: {
    prefs: { "extensions.zotero.httpServer.port": 23249 },
    entries: ["test/zotero"],
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}?.data.initialized`
  }
});
