/** Escape text for inclusion in HTML or SVG markup. */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface BarItem {
  label: string;
  value: number;
  /** Right-hand direct label. Falls back to the raw value. */
  display?: string;
  /** Native tooltip text. */
  title?: string;
}

export interface HBarOptions {
  /** Width reserved for row labels. */
  labelWidth?: number;
  /** Width reserved for the value printed after each bar. */
  valueWidth?: number;
  rowHeight?: number;
  barHeight?: number;
  width?: number;
  /** CSS class applied to the bar rects. */
  barClass?: string;
  /** Axis ticks along the bottom, as [position 0..1, label]. */
  axis?: boolean;
  axisFormat?: (value: number) => string;
}

/**
 * Horizontal bars — the right form when the categories are named things being
 * compared by magnitude, and the names need room to be read.
 */
export function hBarChart(items: BarItem[], options: HBarOptions = {}): string {
  const {
    labelWidth = 92,
    valueWidth = 76,
    rowHeight = 30,
    barHeight = 18,
    width = 720,
    barClass = 'bar-busy',
    axis = true,
    axisFormat = (v) => String(Math.round(v)),
  } = options;

  if (items.length === 0) return '';

  const max = Math.max(...items.map((i) => i.value), 1);
  const trackWidth = width - labelWidth - valueWidth;
  const axisHeight = axis ? 26 : 6;
  const height = items.length * rowHeight + axisHeight;

  const rows = items
    .map((item, index) => {
      const y = index * rowHeight;
      const barY = y + (rowHeight - barHeight) / 2;
      // Never render a positive value as nothing: floor at 3px so it stays visible.
      const w = item.value > 0 ? Math.max(3, (item.value / max) * trackWidth) : 0;
      const radius = Math.min(4, w / 2);
      const display = item.display ?? String(item.value);
      const title = item.title ?? `${item.label}: ${display}`;

      return `    <g>
      <title>${esc(title)}</title>
      <text class="row-label" x="${labelWidth - 10}" y="${barY + barHeight / 2 + 4}" text-anchor="end">${esc(item.label)}</text>
      <rect class="track" x="${labelWidth}" y="${barY}" width="${trackWidth}" height="${barHeight}" rx="3"/>
      ${w > 0 ? `<rect class="${barClass}" x="${labelWidth}" y="${barY}" width="${w.toFixed(1)}" height="${barHeight}" rx="${radius.toFixed(1)}"/>` : ''}
      <text class="row-value" x="${labelWidth + trackWidth + 10}" y="${barY + barHeight / 2 + 4}">${esc(display)}</text>
    </g>`;
    })
    .join('\n');

  const axisMarkup = axis
    ? `    <line class="axis" x1="${labelWidth}" y1="${items.length * rowHeight + 4}" x2="${labelWidth + trackWidth}" y2="${items.length * rowHeight + 4}"/>
    <text class="tick" x="${labelWidth}" y="${items.length * rowHeight + 20}">0</text>
    <text class="tick" x="${labelWidth + trackWidth}" y="${items.length * rowHeight + 20}" text-anchor="end">${esc(axisFormat(max))}</text>`
    : '';

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
    items.map((i) => `${i.label}: ${i.display ?? i.value}`).join('; '),
  )}">
${rows}
${axisMarkup}
  </svg>`;
}

export interface VBarItem {
  label: string;
  /** Shown only on some columns, to keep the axis readable. */
  showLabel?: boolean;
  value: number;
  display?: string;
  title?: string;
}

export interface VBarOptions {
  width?: number;
  height?: number;
  barClass?: string;
  /** Formats the single top gridline label. */
  maxFormat?: (value: number) => string;
}

/**
 * Vertical bars for a date series — time reads left to right, so days must not be
 * rotated into a horizontal chart.
 */
export function vBarChart(items: VBarItem[], options: VBarOptions = {}): string {
  const { width = 720, height = 190, barClass = 'bar-busy', maxFormat = (v) => String(v) } = options;
  if (items.length === 0) return '';

  const padLeft = 46;
  const padBottom = 26;
  const padTop = 12;
  const plotWidth = width - padLeft - 8;
  const plotHeight = height - padBottom - padTop;
  const max = Math.max(...items.map((i) => i.value), 1);

  const slot = plotWidth / items.length;
  // 2px of surface between neighbouring bars, per the mark spec.
  const barWidth = Math.max(2, Math.min(28, slot - 2));

  const bars = items
    .map((item, index) => {
      const h = item.value > 0 ? Math.max(2, (item.value / max) * plotHeight) : 0;
      const x = padLeft + index * slot + (slot - barWidth) / 2;
      const y = padTop + plotHeight - h;
      const radius = Math.min(3, barWidth / 2);
      const title = item.title ?? `${item.label}: ${item.display ?? item.value}`;
      if (h === 0) {
        return `    <g><title>${esc(title)}</title><rect class="track" x="${x.toFixed(1)}" y="${padTop + plotHeight - 2}" width="${barWidth.toFixed(1)}" height="2" rx="1"/></g>`;
      }
      return `    <g><title>${esc(title)}</title><rect class="${barClass}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" rx="${radius.toFixed(1)}"/></g>`;
    })
    .join('\n');

  const ticks = items
    .map((item, index) => {
      if (!item.showLabel) return '';
      const x = padLeft + index * slot + slot / 2;
      return `    <text class="tick" x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle">${esc(item.label)}</text>`;
    })
    .filter(Boolean)
    .join('\n');

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
    `Daily series, ${items.length} days, peak ${maxFormat(max)}`,
  )}">
    <line class="grid" x1="${padLeft}" y1="${padTop}" x2="${width - 8}" y2="${padTop}"/>
    <text class="tick" x="${padLeft - 8}" y="${padTop + 4}" text-anchor="end">${esc(maxFormat(max))}</text>
    <line class="axis" x1="${padLeft}" y1="${padTop + plotHeight}" x2="${width - 8}" y2="${padTop + plotHeight}"/>
    <text class="tick" x="${padLeft - 8}" y="${padTop + plotHeight + 4}" text-anchor="end">0</text>
${bars}
${ticks}
  </svg>`;
}
