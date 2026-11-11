import { buildSync, transformSync } from "esbuild";
import type { ComponentDraft } from "./render-contracts.js";

export function compileComponent(title: string, source: string): ComponentDraft {
  if (!title.trim() || title.length > 120 || !source.trim() || Buffer.byteLength(source) > 160_000) {
    throw new Error("Título ou código fora dos limites da prévia.");
  }
  // Transpile in memory. Imports are never resolved against the server filesystem.
  const module = buildSync({
    stdin: { contents: source, loader: "tsx" }, bundle: false, write: false, metafile: true, format: "esm",
    jsxFactory: "React.createElement", jsxFragment: "React.Fragment", target: "es2022", logLevel: "silent",
  });
  const metadata = Object.values(module.metafile?.outputs ?? {})[0];
  if (!metadata?.exports.includes("default") || metadata.imports.some(({ path, kind }) =>
    path !== "react" || kind !== "import-statement")) {
    throw new Error('Exporte um componente padrão e use somente imports estáticos de "react".');
  }
  const code = module.outputFiles[0]?.text;
  if (!code) throw new Error("O módulo compilado está vazio.");
  const compiled = transformSync(code, { format: "cjs", target: "es2022" }).code;
  return { title, source, compiled };
}
