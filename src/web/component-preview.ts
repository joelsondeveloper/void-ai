import { randomBytes } from "node:crypto";
import { buildSync } from "esbuild";

let previewRuntime: string | undefined;

function runtime() {
  return previewRuntime ??= buildSync({
    stdin: {
      resolveDir: process.cwd(),
      loader: "jsx",
      contents: [
        'import React from "react";',
        'import { createRoot } from "react-dom/client";',
        'function Counter({ label }) {',
        '  const [value, setValue] = React.useState(0);',
        '  return <div className="widget"><span className="widget-label">{label}</span><button type="button" aria-label={label + ": diminuir"} onClick={() => setValue(v => v - 1)}>−</button><output aria-live="polite">{value}</output><button type="button" aria-label={label + ": aumentar"} onClick={() => setValue(v => v + 1)}>+</button></div>;',
        '}',
        'function Toggle({ label }) {',
        '  const [checked, setChecked] = React.useState(false);',
        '  return <label className="widget"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)}/>{label}</label>;',
        '}',
        'window.mountVoidPreview = (render) => createRoot(document.getElementById("preview")).render(render(React, Counter, Toggle));',
        'window.addEventListener("keydown", event => { if (event.key === "Escape") parent.postMessage("void-preview-escape", "*"); });',
      ].join("\n"),
    },
    bundle: true, write: false, minify: true, platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  }).outputFiles[0]?.text ?? "";
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
    "script-src 'nonce-" + nonce + "'", "style-src 'nonce-" + nonce + "'",
  ].join("; ");
  const script = (runtime() + "\nwindow.mountVoidPreview((React, Counter, Toggle) => {\n" + compiled +
    "\nreturn React.createElement(Component);\n});").replace(/<\/script/gi, "<\\/script");
  return {
    policy,
    html: '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
      '<title>Prévia isolada</title><style nonce="' + nonce + '">' + style + '</style>' +
      '<main id="preview"></main><script nonce="' + nonce + '">' + script + '</script></html>',
  };
}
