import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type DelegateRow = {
  rank: number;
  delegate: string;
  count: number;
  share: number;
  isCoinbase: boolean;
};

type MarketShareJson = {
  chain: string;
  candidates: number;
  currentlyDelegated: number;
  uniqueDelegates: number;
  hasExtraBytesCount?: number;
  rpcFailures?: number;
  coinbaseDelegate?: string | null;
  coinbase?: { rank: number | null; count: number; share: number } | null;
  delegates: DelegateRow[];
};

function loadJson(path: string): MarketShareJson {
  return JSON.parse(readFileSync(path, "utf8")) as MarketShareJson;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatPct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function defaultOutputPath(inputPath: string): string {
  const dir = process.env.OUTPUT_DIR ?? ".";
  const baseName = process.env.OUTPUT_FILE ?? "delegate-market-share-report.html";
  return join(dir, baseName.startsWith("/") ? baseName : baseName);
}

function buildSeries(
  delegates: DelegateRow[],
  topN: number,
  includeCoinbaseSlice: boolean,
) {
  const top = delegates.slice(0, topN);

  let labels = top.map((d) => d.delegate);
  let values = top.map((d) => d.count);

  const remainder = delegates.slice(topN);
  const otherCount = remainder.reduce((acc, d) => acc + d.count, 0);
  if (otherCount > 0) {
    labels.push("Other");
    values.push(otherCount);
  }

  if (includeCoinbaseSlice) {
    const cb = delegates.find((d) => d.isCoinbase);
    if (cb && !labels.includes(cb.delegate)) {
      labels = [cb.delegate, ...labels];
      values = [cb.count, ...values];
    }
  }

  return { labels, values };
}

function buildPareto(delegates: DelegateRow[], maxPoints: number) {
  const total = delegates.reduce((acc, d) => acc + d.count, 0);
  const k = Math.max(1, Math.min(maxPoints, delegates.length));
  const xs: number[] = [];
  const ys: number[] = [];
  let cum = 0;
  for (let i = 0; i < k; i++) {
    cum += delegates[i].count;
    xs.push(i + 1);
    ys.push(total ? cum / total : 0);
  }
  return { xs, ys, total, k };
}

type Bucket = { label: string; min: number; maxInclusive: number | null };

async function main() {
  const input = process.env.INPUT_JSON;
  if (!input) {
    throw new Error(
      "Missing INPUT_JSON (path to <chain>-delegate-market-share.json).",
    );
  }

  const topN = process.env.TOP_N ? Number(process.env.TOP_N) : 15;
  const tableN = process.env.TABLE_N ? Number(process.env.TABLE_N) : 30;
  const paretoMaxPoints = process.env.PARETO_POINTS
    ? Number(process.env.PARETO_POINTS)
    : 500;

  const ms = loadJson(input);
  const outPath = defaultOutputPath(input);

  const pie = buildSeries(ms.delegates, topN, true);

  const tableTop = ms.delegates.slice(0, tableN);
  const tableRowsHtml = tableTop
    .map((d) => {
      const cls = d.isCoinbase ? "cb" : "";
      return `<tr class="${cls}"><td>${d.rank}</td><td><code>${escapeHtml(
        d.delegate,
      )}</code></td><td>${d.count.toLocaleString()}</td><td>${formatPct(
        d.share,
      )}</td></tr>`;
    })
    .join("");

  const pareto = buildPareto(ms.delegates, paretoMaxPoints);

  const title = `${ms.chain.toUpperCase()} EIP-7702 current delegate market share`;
  const coinbaseLine =
    ms.coinbaseDelegate && ms.coinbase
      ? ms.coinbase.rank
        ? `Coinbase delegate ${ms.coinbaseDelegate} is rank #${ms.coinbase.rank} (${ms.coinbase.count.toLocaleString()} / ${ms.currentlyDelegated.toLocaleString()} = ${formatPct(ms.coinbase.share)})`
        : `Coinbase delegate ${ms.coinbaseDelegate} not present (0 currently delegated)`
      : "Coinbase delegate not provided";

  // Uses Plotly from CDN for nice charts; the report is a single HTML file.
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; margin: 24px; color: #0b1220; }
      .muted { color: #5b6477; }
      .grid { display: grid; grid-template-columns: 1fr; gap: 18px; }
      @media (min-width: 1200px) { .grid { grid-template-columns: 1fr 1fr; } }
      .card { border: 1px solid #e6e8ef; border-radius: 12px; padding: 16px; background: #fff; }
      .kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      @media (min-width: 900px) { .kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
      .kpi { border: 1px solid #eef0f6; border-radius: 10px; padding: 12px; }
      .kpi .label { font-size: 12px; color: #5b6477; text-transform: uppercase; letter-spacing: 0.04em; }
      .kpi .value { font-size: 20px; font-weight: 650; margin-top: 4px; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { border-bottom: 1px solid #eef0f6; padding: 8px; text-align: left; }
      tr.cb td { font-weight: 650; }
      code { background: #f6f7fb; padding: 2px 6px; border-radius: 6px; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.30.0.min.js"></script>
  </head>
  <body>
    <h2 style="margin: 0 0 6px 0;">${escapeHtml(title)}</h2>
    <div class="muted" style="margin-bottom: 14px;">
      ${escapeHtml(coinbaseLine)}
    </div>

    <div class="card" style="margin-bottom: 18px;">
      <div class="kpis">
        <div class="kpi"><div class="label">Candidates (ever type-4)</div><div class="value">${ms.candidates.toLocaleString()}</div></div>
        <div class="kpi"><div class="label">Currently delegated</div><div class="value">${ms.currentlyDelegated.toLocaleString()}</div></div>
        <div class="kpi"><div class="label">Unique delegates</div><div class="value">${ms.uniqueDelegates.toLocaleString()}</div></div>
        <div class="kpi"><div class="label">RPC failures</div><div class="value">${(ms.rpcFailures ?? 0).toLocaleString()}</div></div>
      </div>
      <div class="muted" style="margin-top: 10px;">
        Input: <code>${escapeHtml(input)}</code>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h3 style="margin: 0 0 10px 0;">Pie (Top ${topN}${ms.delegates.length > topN ? " + Other" : ""})</h3>
        <div id="pie" style="height: 520px;"></div>
      </div>
      <div class="card">
        <h3 style="margin: 0 0 10px 0;">Cumulative share (Pareto)</h3>
        <div class="muted" style="margin-bottom: 10px;">
          Shows how concentrated delegation is: cumulative % of currently delegated EOAs captured by the top-N delegates.
        </div>
        <div id="pareto" style="height: 520px;"></div>
      </div>
    </div>

    <div class="card" style="margin-top: 18px;">
      <h3 style="margin: 0 0 10px 0;">Top delegates</h3>
      <table>
        <thead>
          <tr><th>Rank</th><th>Delegate</th><th>Count</th><th>Share</th></tr>
        </thead>
        <tbody>
          ${tableRowsHtml}
        </tbody>
      </table>
    </div>

    <script>
      const pieLabels = ${JSON.stringify(pie.labels)};
      const pieValues = ${JSON.stringify(pie.values)};
      const coinbaseDelegate = ${(ms.coinbaseDelegate ?? "").toLowerCase()
        ? JSON.stringify((ms.coinbaseDelegate ?? "").toLowerCase())
        : JSON.stringify("__none__")};
      const OTHER_COLOR = "#cbd5e1";
      const COINBASE_BLUE = "#2563eb";

      function hslColor(h) {
        // Plotly accepts CSS hsl() strings; this avoids needing a hex converter.
        return "hsl(" + h.toFixed(1) + ", 70%, 45%)";
      }

      // Assign a unique color to every explicit slice (every label except "Other"),
      // keep "Other" gray, and force Coinbase to be blue.
      const used = new Set([OTHER_COLOR.toLowerCase(), COINBASE_BLUE.toLowerCase()]);
      let hue = 0;
      const GOLDEN_ANGLE = 137.50776405003785;

      function nextUniqueColor() {
        for (let i = 0; i < 1000; i++) {
          hue = (hue + GOLDEN_ANGLE) % 360;
          const c = hslColor(hue);
          // hsl strings are unique across different hue values, and we don't reuse hues,
          // but still guard against accidental duplication.
          if (!used.has(c.toLowerCase())) {
            used.add(c.toLowerCase());
            return c;
          }
        }
        return "#94a3b8";
      }

      const pieColors = pieLabels.map((label) => {
        if (label === "Other") return OTHER_COLOR;
        if (label.toLowerCase() === coinbaseDelegate) return COINBASE_BLUE;
        return nextUniqueColor();
      });

      Plotly.newPlot("pie", [{
        type: "pie",
        labels: pieLabels,
        values: pieValues,
        textinfo: "label+percent",
        marker: { colors: pieColors },
        sort: false
      }], { margin: { t: 10, l: 10, r: 10, b: 10 } }, { displayModeBar: false });

      const paretoX = ${JSON.stringify(pareto.xs)};
      const paretoY = ${JSON.stringify(pareto.ys)};

      Plotly.newPlot("pareto", [{
        type: "scatter",
        mode: "lines",
        x: paretoX,
        y: paretoY,
        line: { color: "#0f172a", width: 3 },
        hovertemplate: "top %{x}<br>cumulative=%{y:.2%}<extra></extra>",
      }], {
        margin: { t: 10, l: 60, r: 20, b: 50 },
        xaxis: { title: "Top N delegates (rank)" },
        yaxis: { title: "Cumulative share", tickformat: ".0%" }
      }, { displayModeBar: false });
    </script>
  </body>
</html>`;

  writeFileSync(outPath, html);
  console.log(`Wrote report: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

