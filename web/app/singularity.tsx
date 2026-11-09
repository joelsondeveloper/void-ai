export type RingState = "idle" | "processing" | "delegating" | "approval" | "completed" | "failed";

export const ringLabels: Record<RingState, string> = {
  idle: "Em espera", processing: "Interpretando", delegating: "Especialistas em execução",
  approval: "Aguardando sua decisão", completed: "Concluído", failed: "Atenção necessária",
};

export function SingularityRing({ state, compact = false, speaking = false }: { state: RingState; compact?: boolean; speaking?: boolean }) {
  return <div className={compact ? "singularity compact" : "singularity"} data-state={state} data-voice={speaking ? "speaking" : "idle"}>
    <svg viewBox="0 0 280 280" aria-hidden="true">
      <defs>
        <radialGradient id="field"><stop stopColor="currentColor" stopOpacity=".12"/><stop offset="1" stopColor="currentColor" stopOpacity="0"/></radialGradient>
        <linearGradient id="orbit" x2="1" y2="1"><stop stopColor="currentColor"/><stop offset=".47" stopColor="currentColor" stopOpacity=".26"/><stop offset=".8" stopColor="currentColor" stopOpacity=".68"/><stop offset="1" stopColor="currentColor"/></linearGradient>
      </defs>
      <circle cx="140" cy="140" r="139" fill="url(#field)"/>
      <path d="M140 9v20m0 222v20M9 140h20m222 0h20" stroke="currentColor" opacity=".28"/>
      <circle cx="140" cy="140" r="114" className="ring-guide"/>
      <circle cx="140" cy="140" r="96" className="ring-guide ring-dashes"/>
      <circle cx="140" cy="140" r="83" className="ring-glow"/>
      <circle cx="140" cy="140" r="83" className="ring-line"/>
      <circle cx="140" cy="140" r="76" className="ring-guide"/>
      <g className="ring-sweep"><path d="M57 140a83 83 0 0 1 83-83" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/><circle cx="140" cy="57" r="2.7" fill="currentColor"/></g>
      <path d="M140 124v32m-16-16h32" stroke="currentColor" opacity=".24"/>
      <path d="m140 135 5 5-5 5-5-5z" fill="currentColor" opacity=".8"/>
    </svg>
  </div>;
}

export type IconName = "plus" | "arrow" | "focus" | "workspace" | "message" | "layers" | "menu" | "chevron" | "activity" | "close";
const paths: Record<IconName, string> = {
  plus: "M12 5v14M5 12h14", arrow: "M5 12h14m-6-6 6 6-6 6",
  focus: "M9 4H4v5m11-5h5v5m-5 11h5v-5m-11 5H4v-5m8-3h.01",
  workspace: "M4 5h16v14H4zM10 5v14", message: "M5 5h14v11H9l-4 3z",
  layers: "m12 4 8 5-8 5-8-5 8-5zm-8 9 8 5 8-5m-16 4 8 5 8-5",
  menu: "M5 7h14M5 12h14M5 17h14", chevron: "m7 10 5 5 5-5",
  activity: "M3 12h4l3-6 4 12 3-6h4", close: "m6 6 12 12M18 6 6 18",
};
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}
