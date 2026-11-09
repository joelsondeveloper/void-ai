import type { ReactNode } from "react";
import "./styles.css";

export const metadata = {
  title: "VOID · Singularity OS",
  description: "Estação pessoal de trabalho do VOID.",
};

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
