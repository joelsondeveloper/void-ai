import React from "react";
import { createRoot } from "react-dom/client";

const root = createRoot(document.getElementById("preview"));
const source = document.getElementById("worker-source").textContent;
const url = URL.createObjectURL(new Blob([JSON.parse(source)], { type: "text/javascript" }));
const worker = new Worker(url);
URL.revokeObjectURL(url);
const { port1: port, port2 } = new MessageChannel();
worker.postMessage(null, [port2]);

// Block elements that navigate, execute, load resources or modify the document head.
const blockedTags = new Set(("a area audio base body buttonlink embed fencedframe foreignObject frame frameset head html iframe image img link " +
  "meta noscript object param portal script source title track use video animate animateMotion animateTransform set").toLowerCase().split(" "));
const blockedProps = /^(?:on|src|href|xlink|form|ref|dangerously|innerhtml|is$|ping$|action$|key$|children$|constructor$|prototype$|__proto__$|download$|poster$|background$)/i;
const events = new Set(("onClick onDoubleClick onChange onInput onSubmit onReset onKeyDown onKeyUp onFocus onBlur " +
  "onPointerDown onPointerMove onPointerUp onPointerEnter onPointerLeave onPointerCancel onWheel").split(" "));

let alive = true;
let pendingAt = 0;
const fail = () => {
  if (!alive) return;
  alive = false;
  clearInterval(watchdog);
  worker.terminate();
  port.close();
  root.render(React.createElement("p", { role: "alert" }, "A prévia foi interrompida. Peça ao VOID para revisar a interface."));
};

const watchdog = setInterval(() => {
  if (pendingAt && performance.now() - pendingAt > 2_000) fail();
  else if (!pendingAt) { pendingAt = performance.now(); port.postMessage({ type: "ping" }); }
}, 500);

function eventTarget(node) {
  return { value: typeof node?.value === "string" ? node.value.slice(0, 16_000) : "",
    checked: node?.checked === true, name: node?.name ?? "", id: node?.id ?? "" };
}

function element(node, depth, budget) {
  if (--budget.nodes < 0 || depth > 64) throw new Error("Preview tree limit");
  if (typeof node === "string" || node === null) return node;
  if (typeof node !== "object" || !Number.isSafeInteger(node.id) || !Array.isArray(node.children) ||
      typeof node.tag !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(node.tag) ||
      !Array.isArray(node.events) || !node.props || typeof node.props !== "object") throw new Error("Invalid preview tree");
  const { id, tag } = node;
  if (blockedTags.has(tag.toLowerCase())) return null;

  const props = { key: id };
  for (const [key, value] of Object.entries(node.props)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key) || blockedProps.test(key)) continue;
    if (key === "style" && value && typeof value === "object") {
      props.style = Object.fromEntries(Object.entries(value).filter(([property, v]) =>
        /^(?:--)?[a-zA-Z][a-zA-Z0-9-]*$/.test(property) && property !== "constructor" &&
        (typeof v === "string" || typeof v === "number")));
    } else if (["string", "number", "boolean"].includes(typeof value)) props[key] = value;
  }
  for (const name of node.events) {
    if (!events.has(name)) continue;
    props[name] = (event) => {
      if (name === "onSubmit" || name === "onReset") event.preventDefault();
      if (!alive) return;
      port.postMessage({ type: "event", id, event: name, target: eventTarget(event.target),
        currentTarget: eventTarget(event.currentTarget), detail: { type: event.type, key: event.key,
          clientX: event.clientX, clientY: event.clientY, button: event.button,
          shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey } });
    };
  }
  if (tag === "form") props.onSubmit ??= event => event.preventDefault();
  if (tag === "input" && props.type === "file") return null;
  return React.createElement(tag, props, ...node.children.map(child => element(child, depth + 1, budget)));
}

worker.addEventListener("error", (event) => { event.preventDefault(); fail(); });
port.onmessage = ({ data }) => {
  if (data.type === "pong") { pendingAt = 0; return; }
  if (data.type !== "tree" || typeof data.tree !== "string" || data.tree.length > 350_000) { fail(); return; }
  try {
    const tree = JSON.parse(data.tree);
    if (!Array.isArray(tree)) throw new Error("Invalid preview root");
    const budget = { nodes: 2_500 };
    root.render(tree.map(node => element(node, 0, budget)));
  } catch { fail(); }
};
window.addEventListener("pagehide", () => { worker.terminate(); port.close(); clearInterval(watchdog); }, { once: true });
window.addEventListener("keydown", event => { if (event.key === "Escape") parent.postMessage("void-preview-escape", "*"); });
