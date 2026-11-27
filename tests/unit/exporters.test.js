// Report exports (src/utils/exporters.js): the stored zip is a valid .xlsx container, merged cells land
// where the on-screen table puts them, and the PDF is a real PDF.
import { describe, expect, it } from 'vitest';
import { crc32, pdfBytes, place, xlsxBytes } from '../../src/utils/exporters.js';
import { attendanceGrid, psiGrid } from '../../src/pages/ops/WorkStatements.jsx';

// Reads a stored (uncompressed) zip back into { name: text }.
function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const out = {};
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const name = dec.decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const body = bytes.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
    expect(view.getUint32(at + 14, true)).toBe(crc32(body));
    out[name] = dec.decode(body);
    at += 30 + nameLen + size;
  }
  return out;
}

const q = { date_from: '2026-11-01', date_to: '2026-11-30' };
const psi = {
  train: { train_no: '12189', name: 'MAHAKAUSHAL EXP' },
  directions: ['1', '2'],
  journeys: [{ journey_date: '2026-11-01', train: '12189 - 12190', train_name: 'MAHAKAUSHAL EXP', ac: 9, nac: 7, target_janitors: 4,
    coaches: [{ sr: 1, coach_code: 'A1', psi: { 1: 90, 2: 100 }, average: 95 }, { sr: 2, coach_code: 'A2', psi: { 1: null, 2: 100 }, average: 100 }] }],
};

describe('report exports', () => {
  it('crc32 matches the reference value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('places cells around row and column spans', () => {
    const g = psiGrid(psi, q);
    const head = place(g.head);
    expect(head.find((p) => p.cell.content === 'Total No of Coaches')).toMatchObject({ r: 1, c: 2, cs: 2 });
    expect(head.filter((p) => p.r === 1).map((p) => p.c)).toEqual([2, 7, 8]);
    const body = place(g.body);
    expect(body.filter((p) => p.r === 1).map((p) => [p.c, p.cell.content])).toEqual([[5, 2], [6, 'A2'], [7, '—'], [8, '100.00'], [9, 100]]);
  });

  it('writes an xlsx workbook with merges, title and numbers', () => {
    const files = unzip(xlsxBytes(psiGrid(psi, q)));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']));
    const sheet = files['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('WORK STATEMENT FOR THE PERIOD 01-Nov-2026 to 30-Nov-2026 FOR TRAIN NO- 12189 - 12190 (MAHAKAUSHAL EXP)');
    expect(sheet).toContain('<mergeCell ref="C4:D4"/>'); // Total No of Coaches under AC / NAC
    expect(sheet).toContain('<mergeCell ref="A5:A6"/>'); // the date spans the journey's coaches
    expect(sheet).toMatch(/<c r="C5" s="3"><v>9<\/v><\/c>/);
  });

  it('marks absent stages and janitors in the attendance summary', () => {
    const g = attendanceGrid({ train: null, journeys: [{ journey_date: '2026-08-08', train: '12187 - 12188', days: 2, target: 2, present: 1,
      stages: [{ label: 'Source' }, { label: 'END' }],
      staff: [{ slot: 'EHK', name: 'A', emp_id: 'E1', stages: [true, true] }, { slot: 'G1', name: 'B', emp_id: 'J1', stages: [false, false] }] }] }, q);
    expect(g.head[0].slice(-2)).toEqual(['Source', 'END']);
    expect(g.body[1]).toEqual([{ content: 'G1', tone: 'mark' }, { content: 'B (J1)', tone: 'mark' }, { content: 'No', tone: 'bad' }, { content: 'No', tone: 'bad' }]);
  });

  it('writes a PDF', async () => {
    const bytes = await pdfBytes(psiGrid(psi, q));
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
