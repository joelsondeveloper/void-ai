import React from "react";
import reconcile from "react-reconciler";
import { DefaultEventPriority, NoEventPriority } from "react-reconciler/constants.js";

const noop = () => {};
const hostContext = {};
let priority = NoEventPriority;
let sequence = 0;

function remove(parent, child) {
  const index = parent.children.indexOf(child);
  if (index >= 0) parent.children.splice(index, 1);
}

function append(parent, child) {
  remove(parent, child);
  parent.children.push(child);
}

function insert(parent, child, before) {
  remove(parent, child);
  parent.children.splice(parent.children.indexOf(before), 0, child);
}

const renderer = reconcile({
  supportsMutation: true,
  supportsMicrotasks: true,
  isPrimaryRenderer: true,
  scheduleMicrotask: queueMicrotask,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  getRootHostContext: () => hostContext,
  getChildHostContext: () => hostContext,
  getPublicInstance: () => null,
  createInstance: (tag, props) => ({ id: ++sequence, tag, props, children: [] }),
  createTextInstance: (text) => ({ text }),
  appendInitialChild: append,
  appendChild: append,
  appendChildToContainer: append,
  insertBefore: insert,
  insertInContainerBefore: insert,
  removeChild: remove,
  removeChildFromContainer: remove,
  clearContainer: (root) => { root.children.length = 0; },
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  prepareForCommit: () => null,
  resetAfterCommit: (root) => root.flush(),
  commitUpdate: (node, _type, _old, props) => { node.props = props; },
  commitTextUpdate: (node, _old, text) => { node.text = text; },
  hideInstance: (node) => { node.hidden = true; },
  hideTextInstance: (node) => { node.hidden = true; },
  unhideInstance: (node) => { node.hidden = false; },
  unhideTextInstance: (node) => { node.hidden = false; },
  detachDeletedInstance: noop,
  getCurrentUpdatePriority: () => priority,
  setCurrentUpdatePriority: (value) => { priority = value; },
  resolveUpdatePriority: () => priority || DefaultEventPriority,
  maySuspendCommit: () => false,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: noop,
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1,
  NotPendingTransition: null,
  HostTransitionContext: React.createContext(null),
});

function Counter({ label }) {
  const [value, setValue] = React.useState(0);
  return React.createElement("div", { className: "widget" },
    React.createElement("span", { className: "widget-label" }, label),
    React.createElement("button", { type: "button", "aria-label": label + ": diminuir", onClick: () => setValue(v => v - 1) }, "−"),
    React.createElement("output", { "aria-live": "polite" }, value),
    React.createElement("button", { type: "button", "aria-label": label + ": aumentar", onClick: () => setValue(v => v + 1) }, "+"));
}

function Toggle({ label }) {
  const [checked, setChecked] = React.useState(false);
  return React.createElement("label", { className: "widget" },
    React.createElement("input", { type: "checkbox", checked, onChange: event => setChecked(event.target.checked) }), label);
}

globalThis.addEventListener("message", ({ ports: [port] }) => {
  const send = port.postMessage.bind(port);
  const fail = () => send({ type: "error" });
  const handlers = new Map();
  let scheduled = false;
  const root = {
    children: [],
    flush() {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        handlers.clear();
        let count = 0;
        const serialize = (node, depth) => {
          if (++count > 2_500 || depth > 64) throw new Error("Preview tree limit");
          if (node.hidden) return null;
          if ("text" in node) return node.text.slice(0, 16_000);
          const props = Object.create(null);
          const events = [];
          for (const [key, value] of Object.entries(node.props)) {
            if (key === "children" || key === "ref") continue;
            if (typeof value === "function" && /^on[A-Z]/.test(key)) {
              events.push(key);
              handlers.set(node.id + ":" + key, value);
            } else if (["string", "number", "boolean"].includes(typeof value)) {
              props[key] = typeof value === "string" ? value.slice(0, 16_000) : value;
            } else if (key === "style" && value && typeof value === "object") {
              props.style = Object.fromEntries(Object.entries(value).slice(0, 256).filter(([, v]) =>
                typeof v === "number" || (typeof v === "string" && v.length <= 2_000)));
            }
          }
          return { id: node.id, tag: node.tag, props, events, children: node.children.map(child => serialize(child, depth + 1)) };
        };
        try {
          const tree = JSON.stringify(root.children.map(node => serialize(node, 0)));
          if (tree.length > 350_000) throw new Error("Preview payload limit");
          send({ type: "tree", tree });
        } catch { fail(); }
      }, 16);
    },
  };

  port.onmessage = ({ data }) => {
    if (data.type === "ping") { send({ type: "pong" }); return; }
    const handler = handlers.get(data.id + ":" + data.event);
    if (!handler) return;
    try {
      renderer.discreteUpdates(() => handler({
        ...data.detail, target: data.target, currentTarget: data.currentTarget,
        preventDefault: noop, stopPropagation: noop,
      }));
    } catch { fail(); }
  };
  try {
    // The opaque frame and its inherited CSP confine the worker. Remove subworker
    // creation and APIs that can allocate or block independently of its lifetime.
    for (const name of ["Worker", "SharedWorker", "WebAssembly", "SharedArrayBuffer", "Atomics",
      "BroadcastChannel", "indexedDB", "caches", "OffscreenCanvas"]) {
      Object.defineProperty(globalThis, name, { value: undefined, configurable: false });
    }
    const module = { exports: {} };
    const require = (name) => {
      if (name === "react") return React;
      throw new Error("Preview imports only React");
    };
    const Component = globalThis.loadVoidComponent(require, module, module.exports, React, Counter, Toggle);
    if (!Component) throw new Error("No default component");
    const container = renderer.createContainer(root, 1, null, false, null, "preview", fail, fail, fail, fail, null);
    renderer.updateContainer(React.createElement(Component), container, null, null);
  } catch { fail(); }
}, { once: true });
