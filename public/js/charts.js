// small self-made SVG bar chart (no internet / libraries needed)
import { esc, fmt } from './core.js';

const short = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `${fmt(n / 1e6)}მ`;
  if (a >= 1e4) return `${fmt(Math.round(n / 1000))}ათ`;
  return fmt(Math.round(n));
};

function niceStep(range) {
  const raw = range / 4 || 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
}

// data: [{ label, title, values: [..] }], series: [{ name, color }]
export function barChart({ data, series, height = 270 }) {
  if (!data.length) return '<p class="hint">ამ პერიოდში მონაცემები არ არის.</p>';
  const W = 1400; const H = height;
  const pad = { l: 56, r: 10, t: 12, b: 30 };
  const plotW = W - pad.l - pad.r; const plotH = H - pad.t - pad.b;
  const all = data.flatMap((d) => d.values);
  let min = Math.min(0, ...all); let max = Math.max(0, ...all);
  if (min === max) max = 1;
  const step = niceStep(max - min);
  min = Math.floor(min / step) * step; max = Math.ceil(max / step) * step;
  const y = (v) => pad.t + ((max - v) / (max - min)) * plotH;

  let grid = '';
  for (let v = min; v <= max + step / 2; v += step) {
    grid += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="${v === 0 ? 'axis' : 'grid'}"/>
      <text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end" class="tick">${short(v)}</text>`;
  }

  const band = plotW / data.length;
  const groupW = Math.min(band * 0.7, 90);
  const barW = groupW / series.length;
  const every = Math.ceil(data.length / 16);
  let bars = '';
  data.forEach((d, i) => {
    const x0 = pad.l + i * band + (band - groupW) / 2;
    d.values.forEach((v, s) => {
      const top = Math.min(y(v), y(0)); const h = Math.max(Math.abs(y(v) - y(0)), v ? 1.5 : 0);
      bars += `<rect x="${x0 + s * barW + 1}" y="${top}" width="${Math.max(barW - 2, 1)}" height="${h}" rx="2" fill="${series[s].color}">
        <title>${esc(d.title ?? d.label)} — ${esc(series[s].name)}: ${fmt(v)} ₾</title></rect>`;
    });
    if (i % every === 0)
      bars += `<text x="${pad.l + i * band + band / 2}" y="${H - 10}" text-anchor="middle" class="tick">${esc(d.label)}</text>`;
  });

  return `
    <div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${grid}${bars}</svg>`;
}
