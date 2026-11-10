"use client";

import { useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { panelRegistry, type PanelId } from "../../src/web/ui-contracts";
import { Icon } from "./singularity";

interface Bounds { x: number; y: number; width: number; height: number }
interface Viewport { width: number; height: number }

const edge = 8;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(value, min));

function fit(bounds: Bounds, viewport: Viewport): Bounds {
  const maxWidth = viewport.width - edge * 2;
  const maxHeight = viewport.height - edge * 2;
  const width = clamp(bounds.width, Math.min(320, maxWidth), maxWidth);
  const height = clamp(bounds.height, Math.min(240, maxHeight), maxHeight);
  return { width, height, x: clamp(bounds.x, edge, viewport.width - width - edge),
    y: clamp(bounds.y, edge, viewport.height - height - edge) };
}

export function FloatingWindow({ panel, title = panelRegistry[panel], activation, minimized, minimize, restore, close, children }: {
  panel: PanelId; title?: string; activation: number; minimized: boolean; minimize: () => void; restore: () => void;
  close: () => void; children: ReactNode;
}) {
  const titleId = useId();
  const frame = useRef<HTMLElement>(null);
  const dock = useRef<HTMLButtonElement>(null);
  const [viewport, setViewport] = useState<Viewport>();
  const [bounds, setBounds] = useState<Bounds>();
  const [maximized, setMaximized] = useState(false);
  const gesture = useRef<{ id: number; x: number; y: number; bounds: Bounds; resize: boolean }>(null);

  useLayoutEffect(() => {
    function measure() {
      const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
      setViewport(viewport);
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useLayoutEffect(() => {
    if (minimized) dock.current?.focus();
    else frame.current?.focus({ preventScroll: true });
  }, [activation, minimized]);

  const width = panel === "usage" || panel === "operations" ? 870 : 660;
  const height = 580;
  const current = viewport && fit(bounds ?? {
    width, height, x: (viewport.width - width) / 2, y: (viewport.height - height) / 2,
  }, viewport);

  function begin(event: PointerEvent<HTMLElement>, resize: boolean) {
    if (!current || maximized || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    frame.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, bounds: current, resize };
  }

  function move(event: PointerEvent<HTMLElement>) {
    const start = gesture.current;
    if (!viewport || !start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const b = start.bounds;
    setBounds(fit(start.resize ? { ...b,
      width: Math.min(b.width + dx, viewport.width - b.x - edge),
      height: Math.min(b.height + dy, viewport.height - b.y - edge),
    } : { ...b, x: b.x + dx, y: b.y + dy }, viewport));
  }

  function end(event: PointerEvent<HTMLElement>) {
    if (gesture.current?.id === event.pointerId) gesture.current = null;
  }

  const toggleSize = () => setMaximized((value) => !value);

  return <>
    <section ref={frame} className="floating-window" role="dialog" aria-labelledby={titleId} tabIndex={-1}
      hidden={minimized} data-maximized={maximized} style={maximized ? undefined : current && {
        left: current.x, top: current.y, width: current.width, height: current.height,
      }}>
      <header className="window-bar">
        <h2 id={titleId} onDoubleClick={toggleSize} onPointerDown={(event) => begin(event, false)}
          onPointerMove={move} onLostPointerCapture={end}>{title}</h2>
        <div className="window-controls">
          <button type="button" aria-label="Minimizar" title="Minimizar" onClick={minimize}>−</button>
          <button type="button" aria-label={maximized ? "Restaurar tamanho" : "Maximizar"}
            title={maximized ? "Restaurar tamanho" : "Maximizar"} onClick={toggleSize}>
            <Icon name={maximized ? "workspace" : "focus"}/>
          </button>
          <button type="button" aria-label="Fechar" title="Fechar" onClick={close}><Icon name="close"/></button>
        </div>
      </header>
      <div className="window-body">{children}</div>
      {!maximized && <div className="window-grip" aria-hidden="true" onPointerDown={(event) => begin(event, true)}
        onPointerMove={move} onLostPointerCapture={end}/>}
    </section>
    {minimized && <button ref={dock} type="button" className="button window-dock" onClick={restore}>
      <Icon name="workspace"/> Restaurar {title}
    </button>}
  </>;
}
