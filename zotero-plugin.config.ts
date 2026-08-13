import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  xpiName: "PaperPet",
  updateURL:
    "https://raw.githubusercontent.com/howarddong711/PaperPet/main/update.json",
  xpiDownloadLink: `https://github.com/howarddong711/PaperPet/releases/download/v${pkg.version}/PaperPet.xpi`,
  build: {
    assets: ["addon/**/*.*"],
    define: {
      buildVersion: pkg.version,
    },
    fluent: {
      dts: false,
    },
    prefs: {
      dts: false,
    },
    makeManifest: {
      enable: false,
    },
    makeUpdateJson: {
      updates: [],
      hash: false,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox140",
        outfile: ".scaffold/build/addon/content/scripts/paperpet.js",
      },
      {
        entryPoints: ["src/settings/preferences-pane.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox140",
        outfile:
          ".scaffold/build/addon/content/scripts/paperpet-preferences.js",
      },
    ],
  },
  server: {
    startArgs: ["-purgecaches"],
  },
  test: {
    waitForPlugin: "() => true",
  },
});
