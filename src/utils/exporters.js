// Report exports. A report is described once as a grid — { title, subtitle, head: [[cell]], body: [[cell]],
// landscape } where a cell is a string/number or { content, rowSpan, colSpan, tone } (tone: 'bad' | 'mark') —
// and the same grid is drawn on screen, written to a real .xlsx workbook (merged cells, bold header, borders)
// and to a real PDF (jsPDF + autotable). Files are saved through the Android app's SwachhFiles plugin (into
// Downloads, then opened), or downloaded by the browser.
import { isNativeApp } from '../security/native.js';

export const cellOf = (c) => (c != null && typeof c === 'object' ? c : { content: c });
const text = (c) => {
  const v = cellOf(c).content;
  return v == null ? '' : String(v);
};

// ---- placement: where every cell lands once row/col spans are taken into account ----------------------

export function place(rows) {
  const taken = new Set();
  const out = [];
  rows.forEach((row, r) => {
    let col = 0;
    row.forEach((raw) => {
      while (taken.has(`${r}:${col}`)) col += 1;
      const cell = cellOf(raw);
      const rs = cell.rowSpan ?? 1;
      const cs = cell.colSpan ?? 1;
      for (let i = 0; i < rs; i += 1) for (let j = 0; j < cs; j += 1) taken.add(`${r + i}:${col + j}`);
      out.push({ r, c: col, rs, cs, cell });
      col += cs;
    });
  });
  return out;
}

// ---- XLSX ------------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A stored (uncompressed) zip: every spreadsheet program reads it, and it needs no library.
export function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = enc.encode(name);
    const body = typeof data === 'string' ? enc.encode(data) : data;
    const crc = crc32(body);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, body.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, body);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, body.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // XML 1.0 forbids most control characters.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
// Styles (cellXfs index): 0 plain, 1 title, 2 header, 3 bordered, 4 bordered red, 5 bordered highlighted.
const STYLE = { title: 1, head: 2, cell: 3, bad: 4, mark: 5 };
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="12"/><name val="Calibri"/></font><font><b/><sz val="10"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FFDC2626"/><name val="Calibri"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFEF08A"/></patternFill></fill></fills>
<borders count="2"><border/><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/></border></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="6"><xf/><xf fontId="1" applyFont="1"/><xf fontId="2" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf borderId="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf fontId="3" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf fillId="3" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs>
</styleSheet>`;

export function xlsxBytes(grid) {
  const header = [grid.title, grid.subtitle].filter(Boolean);
  const top = header.length ? header.length + 1 : 0;
  const width = Math.max(1, ...place(grid.head).map((p) => p.c + p.cs), ...place(grid.body).map((p) => p.c + p.cs));
  const cells = new Map(); // "r:c" -> xml
  const merges = [];
  const widths = new Array(width).fill(8);
  const put = (r, c, cell, style) => {
    const ref = `${colName(c)}${r + 1}`;
    const v = cell.content;
    const st = cell.tone ? STYLE[cell.tone] : style;
    cells.set(`${r}:${c}`, typeof v === 'number' && Number.isFinite(v)
      ? `<c r="${ref}" s="${st}"><v>${v}</v></c>`
      : `<c r="${ref}" s="${st}" t="inlineStr"><is><t xml:space="preserve">${esc(v == null ? '' : String(v))}</t></is></c>`);
  };
  header.forEach((t, i) => {
    put(i, 0, { content: t }, STYLE.title);
    if (width > 1) merges.push(`A${i + 1}:${colName(width - 1)}${i + 1}`);
  });
  const block = (rows, at, style) => {
    for (const p of place(rows)) {
      const r = at + p.r;
      for (let i = 0; i < p.rs; i += 1) for (let j = 0; j < p.cs; j += 1) put(r + i, p.c + j, i || j ? { content: '' } : p.cell, style);
      if (p.rs > 1 || p.cs > 1) merges.push(`${colName(p.c)}${r + 1}:${colName(p.c + p.cs - 1)}${r + p.rs}`);
      if (p.cs === 1) widths[p.c] = Math.min(60, Math.max(widths[p.c], text(p.cell).length + 2));
    }
    return at + rows.length;
  };
  const afterHead = block(grid.head, top, STYLE.head);
  const last = block(grid.body, afterHead, STYLE.cell);
  const rowsXml = [];
  for (let r = 0; r < last; r += 1) {
    const row = [];
    for (let c = 0; c < width; c += 1) if (cells.has(`${r}:${c}`)) row.push(cells.get(`${r}:${c}`));
    if (row.length) rowsXml.push(`<row r="${r + 1}">${row.join('')}</row>`);
  }
  const freeze = afterHead > 0 ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${afterHead}" topLeftCell="A${afterHead + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : '';
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${rowsXml.join('')}</sheetData>${merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}</worksheet>`;
  const sheetName = esc((grid.sheet || 'Report').replace(/[[\]:*?/\\]/g, ' ').slice(0, 31));
  return zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: STYLES_XML },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---- PDF -------------------------------------------------------------------------------------------------

const TONE_PDF = { bad: { textColor: [220, 38, 38] }, mark: { fillColor: [254, 240, 138] } };
const pdfCell = (raw) => {
  const c = cellOf(raw);
  return { content: c.content == null ? '' : String(c.content), rowSpan: c.rowSpan, colSpan: c.colSpan,
    styles: c.tone ? TONE_PDF[c.tone] : undefined };
};

export async function pdfBytes(grid) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ orientation: grid.landscape === false ? 'portrait' : 'landscape', unit: 'pt', format: 'a4' });
  let y = 32;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  const width = doc.internal.pageSize.getWidth();
  for (const line of doc.splitTextToSize(grid.title, width - 48)) {
    doc.text(line, width / 2, y, { align: 'center' });
    y += 14;
  }
  if (grid.subtitle) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(grid.subtitle, width / 2, y, { align: 'center' });
    y += 10;
  }
  autoTable(doc, {
    startY: y + 4,
    head: grid.head.map((r) => r.map(pdfCell)),
    body: grid.body.map((r) => r.map(pdfCell)),
    theme: 'grid',
    margin: { left: 20, right: 20 },
    styles: { fontSize: 7, cellPadding: 2, lineColor: [0, 0, 0], lineWidth: 0.4, textColor: [15, 23, 42], valign: 'middle', overflow: 'linebreak' },
    headStyles: { fillColor: [226, 232, 240], textColor: [15, 23, 42], fontStyle: 'bold', halign: 'center' },
    rowPageBreak: 'avoid',
    didDrawPage: () => {
      doc.setFontSize(7);
      doc.setTextColor(100);
      const h = doc.internal.pageSize.getHeight();
      doc.text(`Swachh Safar · generated ${new Date().toLocaleString('en-IN')}`, 20, h - 12);
      doc.text(`Page ${doc.internal.getNumberOfPages()}`, width - 20, h - 12, { align: 'right' });
      doc.setTextColor(0);
    },
  });
  return new Uint8Array(doc.output('arraybuffer'));
}

// ---- saving ----------------------------------------------------------------------------------------------

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Saves `bytes` as `name`. In the Android app: into Downloads, then opened with an app that can show it.
// Returns a short message saying where it went.
export async function saveFile(bytes, name, mime) {
  const plugin = isNativeApp() ? globalThis.Capacitor?.Plugins?.SwachhFiles : null;
  if (plugin) {
    const res = await plugin.save({ name, mime, data: base64(bytes) });
    return res?.location ? `Saved to ${res.location}` : 'Saved to Downloads';
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return `Downloaded ${name}`;
}

export const safeName = (s) => s.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

export async function exportGrid(grid, kind, baseName) {
  const name = safeName(baseName);
  if (kind === 'pdf') return saveFile(await pdfBytes(grid), `${name}.pdf`, 'application/pdf');
  return saveFile(xlsxBytes(grid), `${name}.xlsx`, XLSX_MIME);
}
