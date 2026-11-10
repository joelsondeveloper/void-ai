import { transformSync } from "esbuild";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentDraft } from "./render-contracts.js";

const tags = new Set("section article div header footer h1 h2 h3 p strong em small span ul ol li table thead tbody tr th td Counter Toggle".split(" "));
const classes = new Set("stack grid card metric muted accent".split(" "));

type Element = { tag: string; props: Record<string, string>; children: (Element | string)[] };

function invalid(reason: string): never {
  throw new Error(reason);
}

function propsFor(tag: string, attributes: string): Record<string, string> {
  const props: Record<string, string> = {};
  const tokens = /\s+([a-zA-Z][\w-]*)="([^"<>{}]*)"/gy;
  let offset = 0;
  while (attributes.slice(offset).trim()) {
    tokens.lastIndex = offset;
    const match = tokens.exec(attributes);
    if (!match) invalid("Use somente atributos com valores entre aspas duplas.");
    const [, name = "", value = ""] = match;
    const valid = tag === "Counter" || tag === "Toggle"
      ? name === "label" && value.trim().length > 0 && value.length <= 120
      : (name === "className" && value.split(/\s+/).every((item) => classes.has(item))) ||
        (name === "aria-label" && value.length <= 120);
    if (!valid || Object.hasOwn(props, name)) invalid("Atributo incompatível com o elemento.");
    props[name] = value;
    offset = tokens.lastIndex;
  }
  if ((tag === "Counter" || tag === "Toggle") && !props.label) invalid("Counter e Toggle precisam de label.");
  return props;
}

function parseJsx(jsx: string): Element {
  const root: Element = { tag: "", props: {}, children: [] };
  const stack = [root];
  const tokens = /<\/([a-zA-Z][\w]*)\s*>|<([a-zA-Z][\w]*)(\s[^<>]*?)?(\/?)>|([^<>{}]+)/gy;
  let count = 0;
  for (let offset = 0; offset < jsx.length;) {
    tokens.lastIndex = offset;
    const token = tokens.exec(jsx);
    const parent = stack.at(-1);
    if (!token || !parent || ++count > 320) invalid("Estrutura TSX inválida ou extensa demais.");
    const [, end, tag, attributes, selfClosing, text] = token;
    if (end) {
      if (parent.tag !== end) invalid("As tags de abertura e fechamento precisam corresponder.");
      stack.pop();
    } else if (tag) {
      if (!tags.has(tag) || stack.length > 16) invalid("Tag ou profundidade fora dos limites da prévia.");
      if ((tag === "Counter" || tag === "Toggle") && !selfClosing) invalid("Use Counter e Toggle como tags autocontidas.");
      if (selfClosing && tag !== "Counter" && tag !== "Toggle") invalid("Feche explicitamente as tags HTML.");
      const element = { tag, props: propsFor(tag, attributes ?? ""), children: [] };
      parent.children.push(element);
      if (!selfClosing) stack.push(element);
    } else if (text?.trim()) {
      parent.children.push(text);
    }
    offset = tokens.lastIndex;
  }
  const element = root.children[0];
  if (stack.length !== 1 || root.children.length !== 1 || !element || typeof element === "string") {
    invalid("O componente precisa retornar uma única árvore JSX.");
  }
  return element;
}

function smoke(node: Element | string): ReactNode {
  if (typeof node === "string") return node;
  if (node.tag === "Counter" || node.tag === "Toggle") return createElement("button", {}, node.props.label);
  return createElement(node.tag, node.props, ...node.children.map(smoke));
}

export function compileComponent(title: string, source: string): ComponentDraft {
  if (!title.trim() || title.length > 120 || source.length > 12_000) invalid("Título ou código fora dos limites.");
  const component = /^export default function Component\(\)\s*\{\s*return\s*\(([\s\S]+)\);\s*\}$/.exec(source.trim());
  const jsx = component?.[1]?.trim();
  if (!jsx) invalid("Use export default function Component() { return (...); }.");
  const tree = parseJsx(jsx);
  if (!renderToStaticMarkup(smoke(tree)).trim()) invalid("O componente precisa renderizar conteúdo.");
  const compiled = transformSync("function Component() { return (" + jsx + "); }", {
    loader: "tsx", jsxFactory: "React.createElement", target: "es2022",
  }).code;
  return { title, source, compiled };
}
