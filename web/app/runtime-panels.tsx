import type { DisplayBlock, DisplaySchema } from "../../src/web/ui-contracts";

const format = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 12 });
const display = (value: string | number | null) => typeof value === "number" ? format.format(value) : value ?? "—";

function Block({ block }: { block: DisplayBlock }) {
  switch (block.kind) {
    case "card": return <article className="display-block">
      <h4>{block.title}</h4><strong className="display-value">{display(block.value)}</strong>
      {block.detail && <p className="muted">{block.detail}</p>}
    </article>;
    case "table": return <div className="display-block display-table">
      <table><caption>{block.title}</caption><thead><tr>
        {block.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}
      </tr></thead><tbody>{block.rows.map((row, index) => <tr key={index}>
        {row.map((value, column) => <td key={column}>{display(value)}</td>)}
      </tr>)}</tbody></table>
    </div>;
    case "bar_chart": {
      const min = Math.min(0, ...block.points.map(({ value }) => value));
      const max = Math.max(0, ...block.points.map(({ value }) => value));
      const range = max - min || 1;
      return <figure className="display-block display-chart">
        <figcaption>{block.title}</figcaption>
        <ul>{block.points.map(({ label, value }, index) => <li key={index}>
          <span>{label}</span>
          <span className="display-track" aria-hidden="true">
            <span className="display-baseline" style={{ left: (-min / range) * 100 + "%" }}/>
            <span className="display-bar" style={{
              left: ((Math.min(0, value) - min) / range) * 100 + "%",
              width: (Math.abs(value) / range) * 100 + "%",
            }}/>
          </span>
          <span>{display(value)}</span>
        </li>)}</ul>
      </figure>;
    }
  }
}

export function DynamicDisplay({ schema }: { schema: DisplaySchema | null }) {
  if (!schema) return <p className="muted">Peça ao VOID para exibir uma tabela, gráfico ou cartão.</p>;
  return <section className="dynamic-display"><h3>{schema.title}</h3>
    {schema.blocks.map((block, index) => <Block key={index} block={block}/>)}
  </section>;
}
