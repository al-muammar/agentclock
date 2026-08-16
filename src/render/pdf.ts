/**
 * A very small PDF writer — the vector counterpart of `svg.ts`.
 *
 * The one-pager is handed to other people as a file, and the project takes no
 * runtime dependencies, so the PDF is emitted directly rather than through a
 * library or a headless browser: PDF 1.4, the base-14 Helvetica pair, filled
 * rectangles and text. That is everything a one-pager needs, and it keeps
 * `npx agentclock` a single package.
 *
 * Content streams are left uncompressed. A one-pager is tens of kilobytes either
 * way, and an uncompressed stream can be read — and asserted against — with a
 * text editor, which is worth more here than the bytes.
 */

/** Base-14 fonts we embed by reference. No font data ships in the file. */
export type FontKey = 'regular' | 'bold';

/**
 * Glyph widths in 1/1000 em, from the Adobe AFM metrics, for codes 32–126.
 *
 * Needed for anything other than left-aligned text: without real widths a
 * right-aligned column drifts by several points per row.
 */
const ASCII_WIDTHS: Record<FontKey, readonly number[]> = {
  regular: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
    611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
    222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ],
  bold: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
    611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
    278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ],
};

/** Widths for the handful of non-ASCII WinAnsi codes the report actually emits. */
const EXTRA_WIDTHS: Record<number, readonly [number, number]> = {
  133: [1000, 1000], // …
  145: [222, 238], // '
  146: [222, 238], // '
  149: [350, 350], // •
  150: [556, 556], // –
  151: [1000, 1000], // —
  176: [400, 400], // °
  183: [278, 278], // ·
  215: [584, 584], // ×
};

/**
 * The WinAnsi (CP1252) codes that are not Latin-1. Everything in 0xA0–0xFF maps
 * to itself, so only this band needs a table.
 */
const WIN_ANSI_HIGH: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  ƒ: 0x83,
  '„': 0x84,
  '…': 0x85,
  '†': 0x86,
  '‡': 0x87,
  ˆ: 0x88,
  '‰': 0x89,
  Š: 0x8a,
  '‹': 0x8b,
  Œ: 0x8c,
  Ž: 0x8e,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '˜': 0x98,
  '™': 0x99,
  š: 0x9a,
  '›': 0x9b,
  œ: 0x9c,
  ž: 0x9e,
  Ÿ: 0x9f,
};

/** Characters with no WinAnsi code but an obvious ASCII reading. */
const TRANSLITERATE: Record<string, string> = {
  '≥': '>=',
  '≤': '<=',
  '≈': '~',
  '→': '->',
  '′': "'",
  '″': '"',
  '\t': ' ',
};

/**
 * Map text onto WinAnsi bytes, returned as a latin1 string — one char per byte.
 *
 * Project names are user data and can contain anything. Rather than dropping what
 * does not fit, an accented letter falls back to its base letter (NFD, minus the
 * combining marks), which keeps `Ångström` readable as `Angstrom`.
 */
export function encodeWinAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x0a || cp === 0x0d) continue;
    if (cp >= 0x20 && cp <= 0x7e) {
      out += ch;
      continue;
    }
    const high = WIN_ANSI_HIGH[ch];
    if (high !== undefined) {
      out += String.fromCharCode(high);
      continue;
    }
    if (cp >= 0xa0 && cp <= 0xff) {
      out += ch;
      continue;
    }
    const literal = TRANSLITERATE[ch];
    if (literal !== undefined) {
      out += encodeWinAnsi(literal);
      continue;
    }
    // Strip diacritics and try again; a letter that survives is better than '?'.
    const folded = ch.normalize('NFD').replace(/\p{M}+/gu, '');
    out += folded && folded !== ch ? encodeWinAnsi(folded) : '?';
  }
  return out;
}

function byteWidth(code: number, font: FontKey): number {
  if (code >= 32 && code <= 126) return ASCII_WIDTHS[font][code - 32] ?? 556;
  const extra = EXTRA_WIDTHS[code];
  if (extra) return extra[font === 'bold' ? 1 : 0];
  // Accented letters share their base letter's width in Helvetica.
  const base = String.fromCharCode(code)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');
  const first = base.charCodeAt(0);
  if (first >= 32 && first <= 126) return ASCII_WIDTHS[font][first - 32] ?? 556;
  return 556;
}

/** Width of `text` in points, including the trailing gap of any letter tracking. */
export function textWidth(text: string, font: FontKey, size: number, tracking = 0): number {
  const encoded = encodeWinAnsi(text);
  let units = 0;
  for (let i = 0; i < encoded.length; i++) units += byteWidth(encoded.charCodeAt(i), font);
  // Tracking is added after every glyph including the last, but that trailing gap
  // must not count when aligning — it is space beyond the ink.
  return (units / 1000) * size + Math.max(0, encoded.length - 1) * tracking;
}

/** Shorten to fit `maxWidth`, ending in an ellipsis. Returns the text unchanged if it fits. */
export function fitText(
  text: string,
  font: FontKey,
  size: number,
  maxWidth: number,
  tracking = 0,
): string {
  if (textWidth(text, font, size, tracking) <= maxWidth) return text;
  const chars = [...text];
  for (let take = chars.length - 1; take > 0; take--) {
    const candidate = `${chars.slice(0, take).join('').trimEnd()}…`;
    if (textWidth(candidate, font, size, tracking) <= maxWidth) return candidate;
  }
  return '…';
}

/** PDF numbers: two decimals is well below what 72dpi user space can resolve. */
function num(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function channel(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}

/** `#00786A` → `0 0.471 0.416 rg`. Colours are written as hex to match the CSS palette. */
function colorOp(hex: string, stroke: boolean): string {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  const r = Number.parseInt(full.slice(0, 2), 16) / 255;
  const g = Number.parseInt(full.slice(2, 4), 16) / 255;
  const b = Number.parseInt(full.slice(4, 6), 16) / 255;
  return `${channel(r)} ${channel(g)} ${channel(b)} ${stroke ? 'RG' : 'rg'}`;
}

/** Escape a PDF literal string. Unbalanced parentheses would end it early. */
function pdfString(text: string): string {
  return `(${encodeWinAnsi(text).replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

export interface TextOptions {
  font?: FontKey;
  size?: number;
  color?: string;
  align?: 'left' | 'center' | 'right';
  /** Extra space between glyphs, in points. Used for the tracked uppercase labels. */
  tracking?: number;
}

export interface BoxOptions {
  fill?: string;
  stroke?: string;
  lineWidth?: number;
  /** Corner radius, in points. */
  radius?: number;
}

/**
 * One page, drawn in top-down coordinates.
 *
 * PDF's origin is the bottom-left corner with y increasing upwards. Every layout
 * in this codebase reads top-down, so the flip happens here, once, rather than in
 * every call site.
 */
export class PdfPage {
  readonly ops: string[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  private flip(y: number): number {
    return this.height - y;
  }

  /** Rectangle with `y` as its top edge. */
  box(x: number, y: number, width: number, height: number, options: BoxOptions = {}): void {
    const { fill, stroke, lineWidth = 0.75, radius = 0 } = options;
    if (!fill && !stroke) return;
    if (fill) this.ops.push(colorOp(fill, false));
    if (stroke) this.ops.push(colorOp(stroke, true), `${num(lineWidth)} w`);

    const top = this.flip(y);
    const bottom = this.flip(y + height);
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));

    if (r === 0) {
      this.ops.push(`${num(x)} ${num(bottom)} ${num(width)} ${num(height)} re`);
    } else {
      // Circular arcs as cubic Béziers; 0.5523 is the usual quarter-circle constant.
      const k = r * 0.5523;
      const right = x + width;
      this.ops.push(
        `${num(x + r)} ${num(bottom)} m`,
        `${num(right - r)} ${num(bottom)} l`,
        `${num(right - r + k)} ${num(bottom)} ${num(right)} ${num(bottom + r - k)} ${num(right)} ${num(bottom + r)} c`,
        `${num(right)} ${num(top - r)} l`,
        `${num(right)} ${num(top - r + k)} ${num(right - r + k)} ${num(top)} ${num(right - r)} ${num(top)} c`,
        `${num(x + r)} ${num(top)} l`,
        `${num(x + r - k)} ${num(top)} ${num(x)} ${num(top - r + k)} ${num(x)} ${num(top - r)} c`,
        `${num(x)} ${num(bottom + r)} l`,
        `${num(x)} ${num(bottom + r - k)} ${num(x + r - k)} ${num(bottom)} ${num(x + r)} ${num(bottom)} c`,
        'h',
      );
    }

    this.ops.push(fill && stroke ? 'B' : fill ? 'f' : 'S');
  }

  line(x1: number, y1: number, x2: number, y2: number, color: string, lineWidth = 0.75): void {
    this.ops.push(
      colorOp(color, true),
      `${num(lineWidth)} w`,
      `${num(x1)} ${num(this.flip(y1))} m`,
      `${num(x2)} ${num(this.flip(y2))} l`,
      'S',
    );
  }

  /** Draw text with `y` as the baseline. Returns the width that was drawn. */
  text(value: string, x: number, y: number, options: TextOptions = {}): number {
    const {
      font = 'regular',
      size = 10,
      color = '#11171A',
      align = 'left',
      tracking = 0,
    } = options;
    if (value === '') return 0;

    const width = textWidth(value, font, size, tracking);
    const left = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;

    this.ops.push(
      'BT',
      `/${font === 'bold' ? 'F2' : 'F1'} ${num(size)} Tf`,
      `${num(tracking)} Tc`,
      colorOp(color, false),
      `1 0 0 1 ${num(left)} ${num(this.flip(y))} Tm`,
      `${pdfString(value)} Tj`,
      'ET',
    );
    return width;
  }

  toStream(): string {
    return this.ops.join('\n');
  }
}

export interface PdfMeta {
  title: string;
  subject?: string;
  author?: string;
  createdAt: number;
}

/** `D:20260816143000+02'00'` — PDF's own date syntax. */
function pdfDate(at: number): string {
  const d = new Date(at);
  const p = (v: number) => String(v).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}'${p(abs % 60)}'`
  );
}

/**
 * Assemble the file.
 *
 * The cross-reference table holds a byte offset per object, so the objects are
 * serialised in order and measured as they go — anything that changes a byte
 * count after the fact would corrupt the file.
 */
export function buildPdf(pages: PdfPage[], meta: PdfMeta): Buffer {
  if (pages.length === 0) throw new Error('a PDF needs at least one page');

  const objects: string[] = [];
  /** Objects are 1-indexed in the file; `push` returns the number just assigned. */
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  // Reserve 1 and 2 for the catalog and the page tree, which reference objects
  // that do not exist yet.
  const catalog = add('');
  const tree = add('');

  const fontRegular = add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  const fontBold = add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  );

  const pageIds: number[] = [];
  for (const page of pages) {
    const stream = page.toStream();
    const contents = add(
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${tree} 0 R ` +
          `/MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
          `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> ` +
          `/Contents ${contents} 0 R >>`,
      ),
    );
  }

  const info = add(
    `<< /Title ${pdfString(meta.title)} ` +
      (meta.subject ? `/Subject ${pdfString(meta.subject)} ` : '') +
      (meta.author ? `/Author ${pdfString(meta.author)} ` : '') +
      `/Creator ${pdfString('agentclock')} /Producer ${pdfString('agentclock')} ` +
      `/CreationDate ${pdfString(pdfDate(meta.createdAt))} >>`,
  );

  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  const chunks: Buffer[] = [];
  let offset = 0;
  const write = (text: string): void => {
    const buf = Buffer.from(text, 'latin1');
    chunks.push(buf);
    offset += buf.length;
  };

  // A binary comment on line 2 tells any transport that this is not a text file.
  write('%PDF-1.4\n%âãÏÓ\n');

  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    write(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefAt = offset;
  // Every entry is exactly 20 bytes wide; readers rely on that to seek.
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) xref += `${String(at).padStart(10, '0')} 00000 n \n`;
  write(xref);
  write(
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\n` +
      `startxref\n${xrefAt}\n%%EOF\n`,
  );

  return Buffer.concat(chunks);
}
