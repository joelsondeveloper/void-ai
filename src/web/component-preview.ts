import { randomBytes } from "node:crypto";
import { buildSync } from "esbuild";

import { fileURLToPath } from "node:url";

const bundles = new Map<string, string>();

function runtime(file: string): string {
  const cached = bundles.get(file);
  if (cached) return cached;
  const output = buildSync({
    entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, write: false,
    minify: true, platform: "browser", define: { "process.env.NODE_ENV": '"production"' },
  }).outputFiles[0];
  if (!output) throw new Error("Preview runtime bundle is missing.");
  bundles.set(file, output.text);
  return output.text;
}

const style = [
  'html{color-scheme:dark}body{margin:0;padding:16px;font:15px/1.45 system-ui;color:#e7ebf2;background:#10131a}',
  'h1,h2,h3,p{margin:0 0 .55em}.stack{display:grid;gap:12px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));gap:10px}',
  '.card,.widget{border:1px solid #353d50;border-radius:10px;padding:12px;background:#1c2230}.widget{display:flex;align-items:center;gap:10px;margin:5px 0}',
  '.widget{flex-wrap:wrap}.widget-label{flex:1 1 100%;color:#a8b4c9}.widget output{min-width:3ch;text-align:center;font-size:2rem;font-weight:650;font-variant-numeric:tabular-nums}.widget button{min-width:44px;min-height:44px}button:focus-visible,input:focus-visible{outline:2px solid #9cdbff;outline-offset:3px}',
  '.metric{font-size:1.65em;font-weight:650}.muted{color:#a8b4c9}.accent{color:#9cdbff}button{color:inherit;background:#303b50;border:1px solid #67748b;border-radius:5px;font:inherit;padding:2px 10px;cursor:pointer}',
  'table{width:100%;border-collapse:collapse}td,th{text-align:start;border-bottom:1px solid #353d50;padding:6px}',
].join("");

export function previewDocument(compiled: string) {
  const nonce = randomBytes(18).toString("base64");
  const policy = [
    "sandbox allow-scripts", "default-src 'none'", "base-uri 'none'", "form-action 'none'",
    "frame-src 'none'", "object-src 'none'", "frame-ancestors 'self'",
    "script-src 'nonce-" + nonce + "'", "style-src 'unsafe-inline'", "worker-src blob:",
  ].join("; ");
  // This string becomes a worker program, never a script in the DOM realm.
  const worker = runtime("./preview-worker.mjs") +
    "\nglobalThis.loadVoidComponent = function(require, module, exports, React, Counter, Toggle) {\n" +
    compiled + "\n;return module.exports.default ?? (typeof Component === 'function' ? Component : undefined);\n};";
  const payload = JSON.stringify(worker).replace(/</g, "\\u003c");
  return {
    policy,
    html: '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
      '<title>Prévia isolada</title><style>' + style + '</style><main id="preview"></main>' +
      '<script type="application/json" id="worker-source">' + payload + '</script>' +
      '<script nonce="' + nonce + '">' + runtime("./preview-frame.mjs") + '</script></html>',
  };
}
