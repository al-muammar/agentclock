import type { Anonymizer } from '../project.js';
import { dateTime, duration, hours, shortDate, truncate, type HourRange } from '../format.js';
import { esc, hBarChart, timelineTrack, vBarChart, type BarItem, type VBarItem } from './svg.js';
import { ACTIVE_STATUSES, type LiveSession } from '../types.js';
import type { Stats } from '../stats.js';

/**
 * Palette. Both themes were checked with a CVD validator: the busy/waiting pair
 * separates at ΔE 10.4 (light) and 11.3 (dark) under protanopia, comfortably above
 * the ΔE 8 floor. Idle is deliberately near-neutral — "nothing is happening" should
 * read as grey rather than compete for attention.
 */
const STYLE = `
  :root {
    /* Declare that the page handles both themes itself. Without this, Chrome's
       auto-darkening runs on top of the media query and re-inverts SVG fills, so
       chart tracks come out white on a dark page. */
    color-scheme: light dark;

    --ground: #F2F5F6;
    --surface: #FFFFFF;
    --surface-2: #E8EDEF;
    --ink: #11171A;
    --ink-2: #3B4750;
    --muted: #6A7681;
    --line: #D5DDE1;
    --line-soft: #E3E9EC;
    --busy: #00786A;
    --waiting: #B4560F;
    --idle: #7C8794;
    --track: #E3E9EC;

    /* Sequential ramp for concurrency. One hue, light to dark, lightness
       monotonic — it encodes a magnitude, not an identity. */
    --lv1: #C4E4DD;
    --lv2: #84C8BC;
    --lv3: #3BA391;
    --lv4: #00786A;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #0D1114;
      --surface: #161B21;
      --surface-2: #1D242B;
      --ink: #E6ECEF;
      --ink-2: #B2BEC7;
      --muted: #89959F;
      --line: #273038;
      --line-soft: #1F272E;
      --busy: #26A18E;
      --waiting: #D07E33;
      --idle: #6D7986;
      --track: #222A31;

      /* Dark surfaces invert the ramp's direction: dim to bright as level rises. */
      --lv1: #1C4A44;
      --lv2: #276F65;
      --lv3: #2F9A88;
      --lv4: #45C4AC;
    }
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    padding: 0 24px 96px;
    background: var(--ground);
    color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }

  .wrap { max-width: 980px; margin: 0 auto; }

  header.top {
    padding: 56px 0 28px;
    border-bottom: 1px solid var(--line);
    display: flex;
    flex-wrap: wrap;
    gap: 12px 32px;
    align-items: baseline;
    justify-content: space-between;
  }
  h1 {
    font-family: "Avenir Next", "Futura", system-ui, sans-serif;
    font-size: 30px;
    letter-spacing: -.02em;
    font-weight: 600;
    margin: 0;
  }
  .meta {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  section { padding: 34px 0; border-bottom: 1px solid var(--line-soft); }
  section:last-of-type { border-bottom: none; }

  h2 {
    font-family: "Avenir Next", "Futura", system-ui, sans-serif;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -.01em;
    margin: 0 0 3px;
  }
  .sub {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    color: var(--muted);
    margin: 0 0 20px;
  }

  .tiles {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }
  .tile {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 16px 18px;
  }
  .tile .k {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10.5px;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--muted);
    display: block;
    margin-bottom: 8px;
  }
  .tile .v {
    font-family: "Avenir Next", "Futura", system-ui, sans-serif;
    font-size: 27px;
    font-weight: 600;
    letter-spacing: -.02em;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .tile .n { font-size: 12px; color: var(--muted); margin-top: 7px; }
  .v.busy { color: var(--busy); }

  figure {
    margin: 0;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 20px;
    overflow-x: auto;
  }
  svg.chart { width: 100%; height: auto; display: block; overflow: visible; }

  .bar-busy { fill: var(--busy); }
  .track { fill: var(--track); }
  /* SVG marks use fill; the timeline's bars are HTML elements and need background. */
  .lv1 { fill: var(--lv1); }
  .lv2 { fill: var(--lv2); }
  .lv3 { fill: var(--lv3); }
  .lv4 { fill: var(--lv4); }
  .b.lv1 { background-color: var(--lv1); }
  .b.lv2 { background-color: var(--lv2); }
  .b.lv3 { background-color: var(--lv3); }
  .b.lv4 { background-color: var(--lv4); }
  /* ---- activity timeline ---- */

  .tl { display: flex; flex-direction: column; }
  .tl-row {
    display: grid;
    grid-template-columns: 92px 1fr 62px;
    align-items: center;
    gap: 10px;
  }
  .tl-name {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    color: var(--ink-2);
    text-align: right;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tl-total {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }
  .tl-track {
    position: relative;
    display: block;
    height: 13px;
    border-radius: 2px;
    background-color: var(--track);
    /* Three-hour gridlines, drawn on the track itself rather than as elements.
       Uses --line, not --line-soft: the latter is the same value as --track.
       Replaced by positioned rules once zoomed, where the spacing changes. */
    background-image: repeating-linear-gradient(
      to right,
      var(--line) 0 1px,
      transparent 1px 12.5%
    );
    overflow: hidden;
    touch-action: pan-y;
  }
  .tl.zoomed .tl-track { background-image: none; }

  /* Bars live on their own layer so zooming is one transform per track rather
     than repositioning every bar. */
  .tl-bars {
    position: absolute;
    inset: 0;
    transform-origin: 0 50%;
    transform: scaleX(var(--zs, 1)) translateX(calc(var(--zf, 0) * -100%));
  }
  .tl-track .b {
    position: absolute;
    top: 0;
    bottom: 0;
    min-width: 1.5px;
    border-radius: 1px;
  }
  /* Gridlines and the drag preview sit outside the scaled layer so they keep
     their real thickness at any zoom level. */
  .tl-rule {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--line);
    pointer-events: none;
  }
  .tl-sel {
    position: absolute;
    top: 0;
    bottom: 0;
    background: color-mix(in srgb, var(--busy) 22%, transparent);
    border-left: 1px solid var(--busy);
    border-right: 1px solid var(--busy);
    pointer-events: none;
  }

  .tl-zoom {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 0 0 14px 102px;
  }
  .tl-zoom button {
    font: inherit;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px;
    color: var(--ink-2);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 3px 11px;
    cursor: pointer;
  }
  .tl-zoom button:hover { border-color: var(--busy); color: var(--busy); }
  .tl-zoom button[aria-pressed="true"] {
    border-color: var(--busy);
    color: var(--busy);
    font-weight: 600;
  }
  .tl-zoom button:focus-visible { outline: 2px solid var(--busy); outline-offset: 2px; }
  .tl-zoom .tl-range {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px;
    color: var(--muted);
    margin-left: 4px;
  }
  /* ---- hourly distribution ---- */

  .hz-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 14px;
    margin-bottom: 18px;
  }
  .hz-controls label {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px;
    color: var(--muted);
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }
  .hz-controls select {
    font: inherit;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 4px 8px;
  }
  .hz-controls select:focus-visible { outline: 2px solid var(--busy); outline-offset: 1px; }

  .hz-chart {
    display: grid;
    grid-template-columns: repeat(24, 1fr);
    gap: 3px;
    align-items: end;
    height: 150px;
  }
  .hz-col {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    height: 100%;
    position: relative;
  }
  .hz-bar {
    background: var(--busy);
    border-radius: 2px 2px 0 0;
    min-height: 2px;
    width: 100%;
  }
  .hz-bar.zero { background: var(--track); min-height: 2px; }
  .hz-val {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 9.5px;
    color: var(--ink-2);
    text-align: center;
    font-variant-numeric: tabular-nums;
    margin-bottom: 3px;
  }
  .hz-axis {
    display: grid;
    grid-template-columns: repeat(24, 1fr);
    gap: 3px;
    margin-top: 6px;
  }
  .hz-axis span {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 9.5px;
    color: var(--muted);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .hz-empty {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    color: var(--muted);
  }

  /* Per-hour parallel counts inside an opened day. Positioned rather than a grid,
     so the cells stay aligned to the axis when the timeline is zoomed. */
  .tl-hours {
    position: relative;
    display: block;
    height: 15px;
    margin-bottom: 8px;
    overflow: hidden;
  }
  .tl-hours i {
    position: absolute;
    top: 0;
    bottom: 0;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 9.5px;
    font-style: normal;
    line-height: 15px;
    text-align: center;
    border-radius: 2px;
    color: var(--ink-2);
    background: var(--track);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    box-shadow: inset -1px 0 0 var(--surface);
  }
  .tl-hours i.z { color: var(--muted); opacity: .45; }
  .tl-hours i.lv1 { background: var(--lv1); }
  .tl-hours i.lv2 { background: var(--lv2); }
  .tl-hours i.lv3 { background: var(--lv3); color: #fff; }
  .tl-hours i.lv4 { background: var(--lv4); color: #fff; }

  .tl-hint {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10.5px;
    color: var(--muted);
    margin: 10px 0 0 102px;
  }
  .tl-ticks {
    background: none;
    height: 14px;
    overflow: visible;
  }
  .tl-ticks span {
    position: absolute;
    top: 0;
    transform: translateX(-50%);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10px;
    color: var(--muted);
  }
  .tl-ticks span:first-child { transform: none; }

  .tl-day { border: none; background: none; border-radius: 0; }
  .tl-day + .tl-day { border-top: 1px solid var(--line-soft); }
  .tl-day > summary {
    list-style: none;
    cursor: pointer;
    padding: 5px 0;
    font-family: inherit;
    font-weight: 400;
    font-size: inherit;
    border-radius: 3px;
  }
  .tl-day > summary::-webkit-details-marker { display: none; }
  .tl-day > summary:hover .tl-name { color: var(--busy); }
  .tl-day[open] > summary { border-bottom: none; }
  .tl-day[open] > summary .tl-name { color: var(--busy); font-weight: 600; }
  .tl-day > summary:focus-visible { outline: 2px solid var(--busy); outline-offset: 2px; }

  .tl-lanes {
    padding: 6px 0 14px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .tl-lane .tl-track { height: 9px; }
  .tl-lane .tl-name { color: var(--muted); }
  .tl-note {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10.5px;
    color: var(--muted);
    margin: 0 0 6px 102px;
  }
  .tl-lanes .tl-note:last-child { margin: 6px 0 0 102px; }

  @media (max-width: 620px) {
    .tl-row { grid-template-columns: 68px 1fr 52px; gap: 7px; }
    .tl-note { margin-left: 75px; }
  }

  .ramp { display: flex; align-items: center; gap: 7px; }
  .ramp .step { width: 22px; height: 10px; border-radius: 2px; }
  .ramp .step.lv1 { background: var(--lv1); }
  .ramp .step.lv2 { background: var(--lv2); }
  .ramp .step.lv3 { background: var(--lv3); }
  .ramp .step.lv4 { background: var(--lv4); }
  .axis { stroke: var(--line); stroke-width: 1; }
  .grid { stroke: var(--line-soft); stroke-width: 1; }
  .row-label,
  .row-value,
  .tick {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-variant-numeric: tabular-nums;
  }
  .row-label { fill: var(--ink-2); font-size: 11.5px; }
  .row-value { fill: var(--ink-2); font-size: 11.5px; }
  .tick { fill: var(--muted); font-size: 10.5px; }

  .legend { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 14px; }
  .key {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    color: var(--ink-2);
  }
  .dot { width: 9px; height: 9px; border-radius: 2px; flex: none; }
  .dot.busy { background: var(--busy); }
  .dot.waiting { background: var(--waiting); }
  .dot.idle { background: var(--idle); }

  .live { display: flex; flex-wrap: wrap; gap: 10px; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 6px 14px 6px 11px;
    font-size: 13px;
  }
  .chip b { font-variant-numeric: tabular-nums; }

  .tablewrap {
    overflow-x: auto;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--surface);
  }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--line-soft); }
  thead th {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10px;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 600;
    white-space: nowrap;
    background: var(--surface-2);
    border-bottom: 1px solid var(--line);
    position: sticky;
    top: 0;
  }
  tbody tr:last-child td { border-bottom: none; }
  td.num {
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  td.name { font-weight: 500; }
  td.dim { color: var(--muted); }
  .state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11.5px;
  }
  .state.busy { color: var(--busy); }
  .state.waiting { color: var(--waiting); }
  .state.idle { color: var(--idle); }

  .note {
    background: var(--surface);
    border: 1px solid var(--line);
    border-left: 3px solid var(--waiting);
    border-radius: 4px;
    padding: 14px 18px;
    color: var(--ink-2);
    font-size: 13.5px;
  }
  .note + .note { margin-top: 10px; }

  footer {
    padding: 32px 0 0;
    color: var(--muted);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    line-height: 1.7;
  }
  footer a { color: var(--busy); }
`;

/**
 * Timeline zoom.
 *
 * Everything else in this report is static markup, and the day drill-down is
 * plain <details>. Zooming to an arbitrary interval is the one thing that cannot
 * be expressed that way, so it gets script — inline, no network, and entirely
 * optional: with scripting off the timeline still renders the full day and every
 * other feature works.
 *
 * Bars are positioned as a fraction of the day, so zooming is one transform per
 * track rather than repositioning thousands of elements.
 */
const SCRIPT = `
(function () {
  var tl = document.querySelector('[data-tl]');
  if (!tl) return;

  var readout = document.querySelector('[data-tl-range]');
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.tl-zoom button'));
  var from = parseFloat(tl.getAttribute('data-from') || '0');
  var to = parseFloat(tl.getAttribute('data-to') || '1');

  function clock(f) {
    var mins = Math.round(f * 1440);
    if (mins >= 1440) return '24:00';
    var h = Math.floor(mins / 60), m = mins % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  // Gridline spacing that stays legible however far in we are.
  function stepMinutes(span) {
    var candidates = [180, 60, 30, 15, 5, 1];
    for (var i = 0; i < candidates.length; i++) {
      if (span * 1440 / candidates[i] <= 12) return candidates[i];
    }
    return 1;
  }

  function apply() {
    var span = to - from;
    var scale = 1 / span;
    tl.style.setProperty('--zf', from);
    tl.style.setProperty('--zs', scale);
    tl.classList.toggle('zoomed', span < 0.999);

    // Axis labels and per-track rules, drawn unscaled so they keep their weight.
    var step = stepMinutes(span);
    var marks = [];
    var first = Math.ceil(from * 1440 / step) * step;
    for (var m = first; m <= to * 1440 + 0.001; m += step) {
      marks.push({ at: (m / 1440 - from) / span, label: clock(m / 1440) });
    }

    var ticks = tl.querySelector('.tl-ticks');
    if (ticks) {
      ticks.innerHTML = marks.map(function (mark) {
        return '<span style="left:' + (mark.at * 100).toFixed(3) + '%">' + mark.label + '</span>';
      }).join('');
    }

    var tracks = tl.querySelectorAll('.tl-day .tl-track');
    for (var i = 0; i < tracks.length; i++) {
      var old = tracks[i].querySelectorAll('.tl-rule');
      for (var j = 0; j < old.length; j++) old[j].remove();
      if (span >= 0.999) continue;
      for (var k = 0; k < marks.length; k++) {
        var rule = document.createElement('i');
        rule.className = 'tl-rule';
        rule.style.left = (marks[k].at * 100).toFixed(3) + '%';
        tracks[i].appendChild(rule);
      }
    }

    // The agents-per-hour cells are hour-quantised, so they are repositioned
    // rather than transformed — stretched digits would be unreadable.
    var cells = tl.querySelectorAll('.tl-hours i');
    for (var c = 0; c < cells.length; c++) {
      var h = parseInt(cells[c].getAttribute('data-h'), 10);
      var cellFrom = h / 24, cellTo = (h + 1) / 24;
      if (cellTo <= from || cellFrom >= to) {
        cells[c].style.display = 'none';
        continue;
      }
      cells[c].style.display = '';
      var l = Math.max(0, (cellFrom - from) / span);
      var r = Math.min(1, (cellTo - from) / span);
      cells[c].style.left = (l * 100).toFixed(3) + '%';
      cells[c].style.width = ((r - l) * 100).toFixed(3) + '%';
    }

    if (readout) {
      readout.textContent = span >= 0.999 ? 'full day' : clock(from) + ' – ' + clock(to);
    }
    for (var b = 0; b < buttons.length; b++) {
      var bf = parseFloat(buttons[b].getAttribute('data-from'));
      var bt = parseFloat(buttons[b].getAttribute('data-to'));
      var on = Math.abs(bf - from) < 1e-6 && Math.abs(bt - to) < 1e-6;
      buttons[b].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function zoom(a, b) {
    // A selection under a minute is almost always a mis-drag, not an intent.
    if (b - a < 1 / 1440) return;
    from = Math.max(0, a);
    to = Math.min(1, b);
    apply();
  }

  for (var b = 0; b < buttons.length; b++) {
    buttons[b].addEventListener('click', function (event) {
      zoom(parseFloat(event.currentTarget.getAttribute('data-from')),
           parseFloat(event.currentTarget.getAttribute('data-to')));
    });
  }

  // Drag across any track to zoom into that interval.
  var dragging = null;
  var preview = null;

  function fraction(track, clientX) {
    var box = track.getBoundingClientRect();
    if (box.width <= 0) return 0;
    var x = Math.min(Math.max(clientX - box.left, 0), box.width) / box.width;
    return from + x * (to - from);
  }

  tl.addEventListener('pointerdown', function (event) {
    var track = event.target.closest ? event.target.closest('.tl-track') : null;
    if (!track || track.classList.contains('tl-ticks')) return;
    // Let a plain click still toggle the day open.
    dragging = { track: track, start: fraction(track, event.clientX), moved: false };
  });

  tl.addEventListener('pointermove', function (event) {
    if (!dragging) return;
    var current = fraction(dragging.track, event.clientX);
    if (Math.abs(current - dragging.start) < 1e-4) return;
    dragging.moved = true;
    if (!preview) {
      preview = document.createElement('i');
      preview.className = 'tl-sel';
      dragging.track.appendChild(preview);
    }
    var span = to - from;
    var a = (Math.min(dragging.start, current) - from) / span;
    var b = (Math.max(dragging.start, current) - from) / span;
    preview.style.left = (a * 100).toFixed(3) + '%';
    preview.style.width = ((b - a) * 100).toFixed(3) + '%';
  });

  function endDrag(event) {
    if (!dragging) return;
    var moved = dragging.moved;
    var start = dragging.start;
    var track = dragging.track;
    dragging = null;
    if (preview) { preview.remove(); preview = null; }
    if (!moved) return;
    // A real drag zooms; suppress the click so the day does not also toggle.
    event.preventDefault();
    var end = fraction(track, event.clientX);
    zoom(Math.min(start, end), Math.max(start, end));
  }

  tl.addEventListener('pointerup', endDrag);
  tl.addEventListener('pointercancel', function () {
    dragging = null;
    if (preview) { preview.remove(); preview = null; }
  });

  tl.addEventListener('dblclick', function () { from = 0; to = 1; apply(); });

  // ---- hourly distribution ----
  var hz = document.querySelector('[data-hz-chart]');
  var hzData = window.__cctrackHours;
  if (hz && hzData) {
    var daySelect = document.querySelector('[data-hz-day]');
    var metricButtons = Array.prototype.slice.call(document.querySelectorAll('[data-hz-metric]'));
    var metric = 'sessions';
    var COLUMN = { sessions: 0, peak: 1, activeMs: 2 };

    function fmtHours(seconds) {
      if (seconds <= 0) return '0';
      if (seconds < 3600) return Math.round(seconds / 60) + 'm';
      var h = seconds / 3600;
      return (h < 10 ? h.toFixed(1) : Math.round(h)) + 'h';
    }

    function drawHours() {
      var key = daySelect ? daySelect.value : '*';
      var rows = key === '*' ? hzData.all : hzData.days[key];
      if (!rows) rows = hzData.all;

      var column = COLUMN[metric];
      var values = rows.map(function (row) { return row[column]; });
      var max = Math.max.apply(null, values.concat([1]));

      hz.innerHTML = values.map(function (value, hour) {
        var pct = value > 0 ? Math.max(3, (value / max) * 100) : 0;
        var shown = metric === 'activeMs' ? fmtHours(value) : String(value);
        var label = String(hour).padStart(2, '0') + ':00 — ' +
          rows[hour][0] + ' session(s) active, up to ' + rows[hour][1] +
          ' at once, ' + fmtHours(rows[hour][2]) + ' worked';
        return '<div class="hz-col" title="' + label + '">' +
          (value > 0 ? '<span class="hz-val">' + shown + '</span>' : '') +
          '<span class="hz-bar' + (value > 0 ? '' : ' zero') + '" style="height:' + pct.toFixed(1) + '%"></span>' +
          '</div>';
      }).join('');
    }

    if (daySelect) daySelect.addEventListener('change', drawHours);
    for (var mb = 0; mb < metricButtons.length; mb++) {
      metricButtons[mb].addEventListener('click', function (event) {
        metric = event.currentTarget.getAttribute('data-hz-metric');
        for (var k = 0; k < metricButtons.length; k++) {
          metricButtons[k].setAttribute(
            'aria-pressed',
            metricButtons[k] === event.currentTarget ? 'true' : 'false',
          );
        }
        drawHours();
      });
    }
    drawHours();
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { from = 0; to = 1; apply(); }
  });

  apply();
})();
`;

export interface ReportInput {
  stats: Stats;
  live: LiveSession[];
  anon: Anonymizer;
  windowLabel: string;
  generatedAt: number;
  /** Initial zoom window for the timeline, if the caller asked for one. */
  zoom?: HourRange | null;
}

function tile(label: string, value: string, note: string, accent = false): string {
  return `      <div class="tile">
        <span class="k">${esc(label)}</span>
        <div class="v${accent ? ' busy' : ''}">${esc(value)}</div>
        <div class="n">${esc(note)}</div>
      </div>`;
}

function liveSection(live: LiveSession[], anon: Anonymizer): string {
  if (live.length === 0) return '';

  const active = live.filter((s) => ACTIVE_STATUSES.has(s.status));
  const waiting = live.filter((s) => s.status === 'waiting');
  const idle = live.filter((s) => s.status === 'idle');
  const other = live.filter(
    (s) => !ACTIVE_STATUSES.has(s.status) && s.status !== 'waiting' && s.status !== 'idle',
  );

  const rows = [...live]
    .sort((a, b) => {
      const rank = (s: LiveSession) =>
        ACTIVE_STATUSES.has(s.status) ? 0 : s.status === 'waiting' ? 1 : 2;
      return rank(a) - rank(b) || a.startedAt - b.startedAt;
    })
    .map((s) => {
      const cls = ACTIVE_STATUSES.has(s.status)
        ? 'busy'
        : s.status === 'waiting'
          ? 'waiting'
          : 'idle';
      const label = anon.session(s.name ?? s.sessionId.slice(0, 8), s.sessionId);
      const project = anon.projectLabel(s.cwd.replace(/\/\.claude\/worktrees\/[^/]+.*$/, ''));
      const state = s.waitingFor ? `${s.status} · ${s.waitingFor}` : s.status;
      return `          <tr>
            <td class="name">${esc(label)}</td>
            <td class="dim">${esc(project)}</td>
            <td><span class="state ${cls}">● ${esc(state)}</span></td>
            <td class="num">${esc(duration(Date.now() - s.startedAt))}</td>
          </tr>`;
    })
    .join('\n');

  const chips = [
    `<span class="chip"><span class="dot busy"></span><b>${active.length}</b> working</span>`,
    `<span class="chip"><span class="dot waiting"></span><b>${waiting.length}</b> waiting on you</span>`,
    `<span class="chip"><span class="dot idle"></span><b>${idle.length}</b> idle</span>`,
  ];
  if (other.length > 0) {
    chips.push(`<span class="chip"><b>${other.length}</b> unknown state</span>`);
  }

  return `  <section>
    <h2>Right now</h2>
    <p class="sub">${live.length} session${live.length === 1 ? '' : 's'} open · one row per session, subagents included</p>
    <div class="live">${chips.join('\n      ')}</div>
    <div class="tablewrap" style="margin-top:16px">
      <table>
        <thead><tr><th>Session</th><th>Project</th><th>State</th><th style="text-align:right">Uptime</th></tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>
  </section>`;
}

function concurrencySection(stats: Stats): string {
  if (stats.concurrency.length === 0) return '';

  const items: BarItem[] = stats.concurrency.map((b) => ({
    label: `${b.level} busy`,
    value: b.ms,
    display: duration(b.ms),
    title: `${b.level} session${b.level === 1 ? '' : 's'} working simultaneously for ${duration(b.ms)}`,
  }));

  return `  <section>
    <h2>How often you run agents in parallel</h2>
    <p class="sub">Wall-clock time at each level of simultaneous agent work</p>
    <figure>${hBarChart(items, { labelWidth: 78, valueWidth: 84, axisFormat: (v) => duration(v) })}</figure>
  </section>`;
}

function dailySection(stats: Stats): string {
  if (stats.days.length === 0) return '';

  // Fill missing days so gaps read as gaps rather than being silently compressed.
  const first = stats.days[0]!.day;
  const last = stats.days[stats.days.length - 1]!.day;
  const byDay = new Map(stats.days.map((d) => [d.day, d]));
  const filled: VBarItem[] = [];

  const cursor = new Date(`${first}T12:00:00`);
  const end = new Date(`${last}T12:00:00`);
  while (cursor <= end && filled.length < 400) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    const bucket = byDay.get(key);
    const value = bucket?.activeMs ?? 0;
    filled.push({
      label: shortDate(cursor.getTime()),
      value,
      display: duration(value),
      title: bucket
        ? `${key} — ${duration(value)} of agent work across ${bucket.sessions} session${bucket.sessions === 1 ? '' : 's'}, peak ${bucket.peak} at once`
        : `${key} — no agent activity`,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  // Label roughly ten columns, plus the last one, so the axis stays readable.
  const step = Math.max(1, Math.ceil(filled.length / 10));
  filled.forEach((item, i) => {
    item.showLabel = i % step === 0 || i === filled.length - 1;
  });

  return `  <section>
    <h2>Agent work per day</h2>
    <p class="sub">Summed across sessions, so a day with two agents running in parallel can exceed 24 hours</p>
    <figure>${vBarChart(filled, { maxFormat: (v) => `${hours(v, 0)}h` })}</figure>
  </section>`;
}

const _DAY_MS = 86_400_000;

function clockTime(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** How many session lanes a single day shows before it stops listing them. */
const MAX_LANES_PER_DAY = 14;
/** How many days the timeline renders. */
const MAX_TIMELINE_DAYS = 45;

function timelineSection(stats: Stats, anon: Anonymizer, initialZoom: HourRange | null): string {
  if (stats.timeline.length === 0) return '';

  // Newest day first — the recent past is what gets looked at.
  const days = [...stats.timeline].reverse().slice(0, MAX_TIMELINE_DAYS);

  const hours = [0, 3, 6, 9, 12, 15, 18, 21];
  const axis = hours
    .map(
      (hour) =>
        `<span style="left:${((hour / 24) * 100).toFixed(2)}%">${String(hour).padStart(2, '0')}</span>`,
    )
    .join('');

  const presets: Array<[string, number, number]> = [
    ['All day', 0, 1],
    ['Morning', 6 / 24, 12 / 24],
    ['Afternoon', 12 / 24, 18 / 24],
    ['Evening', 18 / 24, 1],
    ['09–19', 9 / 24, 19 / 24],
  ];
  const zoomBar = `      <div class="tl-zoom" role="group" aria-label="Zoom the timeline to a time of day">
${presets
  .map(
    ([label, from, to]) =>
      `        <button type="button" data-from="${from}" data-to="${to}">${esc(label)}</button>`,
  )
  .join('\n')}
        <span class="tl-range" data-tl-range></span>
      </div>`;

  const rows = days
    .map((day, index) => {
      const dayLabel = new Date(day.midnight).toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });

      // Fractions are taken against this day's real length, which a DST
      // transition makes 23 or 25 hours rather than 24.
      const frac = (t: number) => (t - day.midnight) / day.dayMs;

      const summaryBars = day.intervals.map((interval) => {
        const names = interval.projects.map((p) => anon.projectLabel(p));
        const shown = names.slice(0, 3).join(', ');
        const more = names.length > 3 ? ` +${names.length - 3} more` : '';
        return {
          from: frac(interval.start),
          to: frac(interval.end),
          level: interval.level,
          title: `${clockTime(interval.start)}–${clockTime(interval.end)} · ${interval.level} agent${
            interval.level === 1 ? '' : 's'
          } working · ${duration(interval.end - interval.start)}${shown ? ` · ${shown}` : ''}${more}`,
        };
      });

      const lanes = day.lanes.slice(0, MAX_LANES_PER_DAY);
      const hidden = day.lanes.length - lanes.length;

      const laneRows = lanes
        .map((lane) => {
          const name = anon.session(lane.label, lane.sessionId);
          const project = anon.projectLabel(lane.project);
          const bars = lane.spans.map((span) => ({
            from: frac(span.start),
            to: frac(span.end),
            // Level 2 reads clearly against the track without implying concurrency.
            level: 2,
            // The lane already names the session; repeating it on every bar was
            // most of the report's weight.
            title: `${clockTime(span.start)}–${clockTime(span.end)} · ${duration(span.end - span.start)}`,
          }));
          return `        <div class="tl-row tl-lane">
          <span class="tl-name" title="${esc(project)}">${esc(truncate(name, 26))}</span>
          ${timelineTrack(bars, `${name}, ${duration(lane.activeMs)}`)}
          <span class="tl-total">${esc(duration(lane.activeMs))}</span>
        </div>`;
        })
        .join('\n');

      const note =
        hidden > 0
          ? `<p class="tl-note">and ${hidden} shorter session${hidden === 1 ? '' : 's'}</p>`
          : '';

      // Parallel agents per clock hour — the count, not just the shading.
      const hourCells = day.hours
        .map((bucket) => {
          const step = Math.min(Math.max(1, bucket.peak), 4);
          const cls = bucket.peak === 0 ? 'z' : `lv${step}`;
          const title =
            bucket.peak === 0
              ? `${String(bucket.hour).padStart(2, '0')}:00 — no agents working`
              : `${String(bucket.hour).padStart(2, '0')}:00 — up to ${bucket.peak} agent${bucket.peak === 1 ? '' : 's'} at once, ${bucket.sessions} session${bucket.sessions === 1 ? '' : 's'} active, ${duration(bucket.activeMs)} of work`;
          const left = ((bucket.hour / 24) * 100).toFixed(3);
          const width = (100 / 24).toFixed(3);
          return `<i class="${cls}" data-h="${bucket.hour}" style="left:${left}%;width:${width}%" title="${esc(title)}">${bucket.peak === 0 ? '·' : bucket.peak}</i>`;
        })
        .join('');

      return `      <details class="tl-day"${index === 0 ? ' open' : ''}>
        <summary>
          <div class="tl-row">
            <span class="tl-name">${esc(dayLabel)}</span>
            ${timelineTrack(summaryBars, `${dayLabel}, ${duration(day.activeMs)} of agent work, peak ${day.peak}`)}
            <span class="tl-total">${esc(duration(day.activeMs))}</span>
          </div>
        </summary>
        <div class="tl-lanes">
          <p class="tl-note">${day.lanes.length} session${day.lanes.length === 1 ? '' : 's'} worked this day · peak ${day.peak} at once</p>
          <div class="tl-row">
            <span class="tl-name">agents / hour</span>
            <span class="tl-hours">${hourCells}</span>
            <span class="tl-total"></span>
          </div>
${laneRows}
          ${note}
        </div>
      </details>`;
    })
    .join('\n');

  const truncated = stats.timeline.length > days.length;

  return `  <section>
    <h2>When agents were working</h2>
    <p class="sub">Each row is one day, midnight to midnight, local time · click a day to see the individual sessions${
      truncated ? ` · most recent ${days.length} of ${stats.timeline.length} days` : ''
    }</p>
    <figure>
${zoomBar}
      <div class="tl" data-tl${initialZoom ? ` data-from="${initialZoom.from}" data-to="${initialZoom.to}"` : ''}>
        <div class="tl-row tl-axis"><span class="tl-name"></span><span class="tl-track tl-ticks">${axis}</span><span class="tl-total"></span></div>
${rows}
      </div>
      <p class="tl-hint">Drag across any row to zoom into that interval · double-click or Esc to reset · totals on the right are always the whole day</p>
      <div class="legend" style="margin-top:16px">
        <span class="key ramp">
          <span>1</span>
          <span class="step lv1"></span>
          <span class="step lv2"></span>
          <span class="step lv3"></span>
          <span class="step lv4"></span>
          <span>4+ agents at once</span>
        </span>
        <span class="key">hover a segment for exact times</span>
      </div>
    </figure>
  </section>`;
}

/**
 * Hourly distribution, with a day selector.
 *
 * Two measures, switchable, because they answer different questions: how many
 * sessions touched an hour at all, and how many were running at once inside it.
 * They share no axis, so they are never drawn together.
 */
function hourlySection(stats: Stats): string {
  if (stats.timeline.length === 0) return '';

  const options = [...stats.timeline]
    .reverse()
    .map((day) => {
      const label = new Date(day.midnight).toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
      return `<option value="${esc(day.day)}">${esc(label)}</option>`;
    })
    .join('');

  const axis = Array.from({ length: 24 }, (_, hour) =>
    hour % 2 === 0 ? `<span>${String(hour).padStart(2, '0')}</span>` : '<span></span>',
  ).join('');

  return `  <section>
    <h2>Hourly distribution</h2>
    <p class="sub">An hour counts a session if it was working at any point inside it, however briefly</p>
    <figure>
      <div class="hz-controls">
        <label>Day
          <select data-hz-day>
            <option value="*">All days</option>
${options}
          </select>
        </label>
        <div class="tl-zoom" role="group" aria-label="Which measure to chart">
          <button type="button" data-hz-metric="sessions" aria-pressed="true">Sessions active</button>
          <button type="button" data-hz-metric="peak" aria-pressed="false">Agents at once</button>
          <button type="button" data-hz-metric="activeMs" aria-pressed="false">Time worked</button>
        </div>
      </div>
      <div class="hz-chart" data-hz-chart></div>
      <div class="hz-axis">${axis}</div>
    </figure>
  </section>`;
}

/** The hourly buckets, as compact JSON for the selector to switch between. */
function hourlyData(stats: Stats): string {
  const compact = (buckets: Stats['hourly']) =>
    buckets.map((b) => [b.sessions, b.peak, Math.round(b.activeMs / 1000)]);

  const payload = {
    all: compact(stats.hourly),
    days: Object.fromEntries(stats.timeline.map((day) => [day.day, compact(day.hours)])),
  };
  // Closing tags inside a script block would end it early.
  return JSON.stringify(payload).replace(/</g, '\\u003c');
}

function projectSection(stats: Stats, anon: Anonymizer): string {
  if (stats.projects.length === 0) return '';

  const top = stats.projects.slice(0, 12);
  const rest = stats.projects.slice(12);
  const items: BarItem[] = top.map((p) => ({
    label: truncate(anon.projectLabel(p.project), 22),
    value: p.activeMs,
    display: duration(p.activeMs),
    title: `${anon.projectLabel(p.project)}: ${duration(p.activeMs)} across ${p.sessions} session${p.sessions === 1 ? '' : 's'}`,
  }));

  if (rest.length > 0) {
    const otherMs = rest.reduce((sum, p) => sum + p.activeMs, 0);
    if (otherMs > 0) {
      items.push({
        label: `${rest.length} others`,
        value: otherMs,
        display: duration(otherMs),
        title: `${rest.length} further projects totalling ${duration(otherMs)}`,
      });
    }
  }

  return `  <section>
    <h2>Where the time went</h2>
    <p class="sub">Agent working time by project · git worktrees folded into their repository</p>
    <figure>${hBarChart(items, { labelWidth: 168, valueWidth: 84, axisFormat: (v) => duration(v) })}</figure>
  </section>`;
}

function sessionSection(stats: Stats, anon: Anonymizer): string {
  const withWork = stats.sessions.filter((s) => s.activeMs > 0).slice(0, 40);
  if (withWork.length === 0) return '';

  const rows = withWork
    .map((s) => {
      const lifetime = s.endedAt - s.startedAt;
      const ratio = lifetime > 0 ? (100 * s.activeMs) / lifetime : 0;
      return `          <tr>
            <td class="name">${esc(truncate(anon.session(s.label, s.sessionId), 34))}</td>
            <td class="dim">${esc(truncate(anon.projectLabel(s.project), 24))}</td>
            <td class="num">${esc(duration(s.activeMs))}</td>
            <td class="num">${esc(duration(lifetime))}</td>
            <td class="num">${ratio < 1 ? '&lt;1' : Math.round(ratio)}%</td>
            <td class="num">${s.turns}</td>
            <td class="num dim">${esc(shortDate(s.endedAt))}</td>
          </tr>`;
    })
    .join('\n');

  const hidden = stats.sessions.filter((s) => s.activeMs > 0).length - withWork.length;

  return `  <section>
    <h2>Sessions</h2>
    <p class="sub">Ranked by agent working time${hidden > 0 ? ` · showing 40 of ${withWork.length + hidden}` : ''}</p>
    <div class="tablewrap">
      <table>
        <thead>
          <tr>
            <th>Session</th><th>Project</th>
            <th style="text-align:right">Working</th>
            <th style="text-align:right">Lifetime</th>
            <th style="text-align:right">Busy</th>
            <th style="text-align:right">Turns</th>
            <th style="text-align:right">Last active</th>
          </tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>
  </section>`;
}

export function renderReport(input: ReportInput): string {
  const { stats, live, anon, windowLabel, generatedAt } = input;
  const { summary } = stats;

  const tiles = [
    // Count only projects that actually accrued working time — most sessions in a
    // long window are one-prompt shells in their own directory, and counting those
    // makes the project figure look impressive while meaning nothing.
    tile(
      'Sessions',
      String(summary.sessions),
      `in ${stats.projects.filter((p) => p.activeMs > 0).length} active project${
        stats.projects.filter((p) => p.activeMs > 0).length === 1 ? '' : 's'
      }`,
    ),
    tile('Agent work', duration(summary.activeMs), `${summary.turns} completed turns`, true),
    tile('Wall clock', duration(summary.coveredMs), 'time with ≥1 agent working'),
    tile('Parallelism', `${summary.parallelism.toFixed(2)}×`, 'work done per hour elapsed'),
    tile('Peak', String(summary.peakConcurrency), 'most agents at once'),
  ].join('\n');

  const notes: string[] = [];
  if (summary.sessionsWithoutTurnData > 0) {
    notes.push(
      `<div class="note"><strong>${summary.sessionsWithoutTurnData}</strong> of these sessions predate Claude Code 2.1.222, which introduced the per-turn duration record. They are counted as sessions but contribute no working time — an absent number rather than an estimated one.</div>`,
    );
  }
  notes.push(
    `<div class="note">Historical <strong>waiting</strong> time is not shown because it cannot be recovered: nothing in a transcript distinguishes a permission prompt from a coffee break. Waiting appears in <strong>Right now</strong> only.</div>`,
  );

  const body = [
    liveSection(live, anon),
    `  <section>
    <h2>${esc(windowLabel)}</h2>
    <p class="sub">${summary.windowFrom > 0 ? `${esc(shortDate(summary.windowFrom))} – ${esc(shortDate(summary.windowTo))}` : 'no activity recorded'}</p>
    <div class="tiles">
${tiles}
    </div>
  </section>`,
    timelineSection(stats, anon, input.zoom ?? null),
    hourlySection(stats),
    concurrencySection(stats),
    dailySection(stats),
    projectSection(stats, anon),
    sessionSection(stats, anon),
    `  <section>
    <h2>Reading these numbers</h2>
    <p class="sub">What is measured, and what is deliberately absent</p>
${notes.join('\n')}
  </section>`,
  ]
    .filter(Boolean)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cctrack — Claude Code session report</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>Claude Code sessions</h1>
    <div class="meta">${esc(dateTime(generatedAt))}</div>
  </header>
${body}
  <script>window.__cctrackHours=${hourlyData(stats)};</script>
  <script>${SCRIPT}</script>
  <footer>
    Generated by cctrack from ~/.claude · a session with N subagents counts once.<br>
    Working time comes from Claude Code's own per-turn duration records, not from sampling or estimation.<br>
    Claude Code deletes transcripts after 30 days, so this report covers only what remains on disk.
  </footer>
</div>
</body>
</html>
`;
}
