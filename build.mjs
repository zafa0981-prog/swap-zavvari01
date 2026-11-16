import { build } from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";
mkdirSync("www", { recursive: true });
await build({
  entryPoints: ["src/main.js"], bundle: true, minify: true, format: "iife", platform: "browser",
  target: ["chrome90"], outfile: "www/app.js", define: { global: "globalThis", "process.env.NODE_ENV": '"production"' }, logLevel: "info",
});
copyFileSync("src/index.html", "www/index.html");
console.log("built www/");
