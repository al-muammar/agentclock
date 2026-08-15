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

export interface TimelineRow {
  /** Left-hand label, e.g. "Fri 15 Aug". */
  label: string;
  /** Right-hand total, e.g. "4h 12m". */
  total: string;
  /** Bars positioned by fraction of the day, 0 = midnight, 1 = next midnight. */
  bars: Array<{ from: number; to: number; level: number; title: string }>;
}

export interface TimelineOptions {
  width?: number;
  labelWidth?: number;
  totalWidth?: number;
  rowHeight?: number;
  barHeight?: number;
  /** Highest level that gets its own ramp step; above this the top step is reused. */
  maxLevel?: number;
  /** Hour marks along the axis. */
  hourTicks?: number[];
}

/**
 * A day-by-day activity timeline: one row per day, midnight to midnight, with
 * segments where agents were working. Colour intensity encodes how many were
 * working at once — a sequential ramp, since it is a magnitude, not an identity.
 */
export function timelineChart(rows: TimelineRow[], options: TimelineOptions = {}): string {
  const {
    width = 720,
    labelWidth = 88,
    totalWidth = 62,
    rowHeight = 22,
    barHeight = 13,
    maxLevel = 4,
    hourTicks = [0, 3, 6, 9, 12, 15, 18, 21, 24],
  } = options;

  if (rows.length === 0) return '';

  const trackWidth = width - labelWidth - totalWidth;
  const headerHeight = 18;
  const height = rows.length * rowHeight + headerHeight + 8;

  const grid = hourTicks
    .map((hour) => {
      const x = labelWidth + (hour / 24) * trackWidth;
      return `    <line class="grid" x1="${x.toFixed(1)}" y1="${headerHeight - 4}" x2="${x.toFixed(1)}" y2="${headerHeight + rows.length * rowHeight}"/>
    <text class="tick" x="${x.toFixed(1)}" y="${headerHeight - 9}" text-anchor="${hour === 0 ? 'start' : hour === 24 ? 'end' : 'middle'}">${hour === 24 ? '24' : String(hour).padStart(2, '0')}</text>`;
    })
    .join('\n');

  const body = rows
    .map((row, index) => {
      const y = headerHeight + index * rowHeight;
      const barY = y + (rowHeight - barHeight) / 2;

      const segments = row.bars
        .map((bar) => {
          const x = labelWidth + bar.from * trackWidth;
          // Floor at 1.5px: a two-minute burst must still be visible on a 24h axis.
          const w = Math.max(1.5, (bar.to - bar.from) * trackWidth);
          const step = Math.min(Math.max(1, bar.level), maxLevel);
          return `      <rect class="lv${step}" x="${x.toFixed(2)}" y="${barY}" width="${w.toFixed(2)}" height="${barHeight}" rx="1.5"><title>${esc(bar.title)}</title></rect>`;
        })
        .join('\n');

      return `    <g>
      <text class="row-label" x="${labelWidth - 10}" y="${barY + barHeight / 2 + 4}" text-anchor="end">${esc(row.label)}</text>
      <rect class="track" x="${labelWidth}" y="${barY}" width="${trackWidth}" height="${barHeight}" rx="2"/>
${segments}
      <text class="row-value" x="${labelWidth + trackWidth + 8}" y="${barY + barHeight / 2 + 4}">${esc(row.total)}</text>
    </g>`;
    })
    .join('\n');

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
    `Activity timeline, ${rows.length} days, midnight to midnight, darker segments mean more agents working at once`,
  )}">
${grid}
${body}
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
  const {
    width = 720,
    height = 190,
    barClass = 'bar-busy',
    maxFormat = (v) => String(v),
  } = options;
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
