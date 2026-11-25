import { describe, expect, it } from 'vitest';
import { getSchemaVersion, MIGRATIONS, runMigrations } from '../../src/database/migrations.js';
import { applicableQuestions } from '../../src/database/feedbackRepository.js';
import { coachBreakdown, coachText, inferClass, parseCoaches } from '../../src/utils/coaches.js';
import { createMemoryDb } from '../helpers/memoryDb.js';

// A phone database as v14 left it: the class columns accept only AC and NON_AC.
async function v14Db(filename) {
  const db = await createMemoryDb({ migrate: false, filename });
  for (const m of MIGRATIONS.filter((x) => x.version <= 14)) {
    await db.transaction([...m.statements.map((sql) => ({ sql })), { sql: `PRAGMA user_version = ${m.version}` }]);
  }
  await db.run('PRAGMA foreign_keys = OFF'); // coach and question rows without their journey, train and bank
  for (const [code, cls, pos] of [['B1', 'AC', 1], ['S1', 'NON_AC', 2], ['GEN', 'NON_AC', 3], ['GEN2', 'NON_AC', 4], ['UR1', 'NON_AC', 5],
    ['B2', 'NON_AC', 6], ['S2', 'AC', 7], ['BHJ', 'AC', 8], ["X'1", 'NON_AC', 9]]) {
    await db.run('INSERT INTO journey_coaches (journey_id, code, classification, position) VALUES (?, ?, ?, ?)', ['j1', code, cls, pos]);
    await db.run('INSERT INTO train_coaches (train_id, code, classification, position) VALUES (?, ?, ?, ?)', ['t1', code, cls, pos]);
  }
  await db.run(`INSERT INTO feedback_questions (id, bank_id, position, text_en, applies_ac, applies_non_ac)
    VALUES ('q1', 'b1', 1, 'Toilet', 1, 1), ('q2', 'b1', 2, 'Bedroll', 1, 0)`);
  return db;
}

const classes = async (db, table) => Object.fromEntries((await db.query(`SELECT code, classification FROM ${table}`)).map((r) => [r.code, r.classification]));

describe('v15: General coaches are a class of their own on the phone', () => {
  it('moves general coaches to GEN and asks them what Non-AC coaches were asked', async () => {
    const db = await v14Db();
    expect(await runMigrations(db)).toMatchObject({ from: 14, to: 17, applied: [15, 16, 17] });
    // B2 typed as NON_AC and S2 as AC are corrected; BHJ and X'1 say nothing, so they keep what was chosen.
    const want = { B1: 'AC', S1: 'NON_AC', GEN: 'GEN', GEN2: 'GEN', UR1: 'GEN', B2: 'AC', S2: 'NON_AC', BHJ: 'AC', "X'1": 'NON_AC' };
    expect(await classes(db, 'journey_coaches')).toEqual(want);
    expect(await classes(db, 'train_coaches')).toEqual(want);
    expect(await db.query('SELECT id, applies_gen FROM feedback_questions ORDER BY position')).toEqual([
      { id: 'q1', applies_gen: 1 }, { id: 'q2', applies_gen: 0 }]);
  });

  it('accepts GEN in every class column, still refuses anything else, and keeps doing so after a reload', async () => {
    const filename = `/gen-${crypto.randomUUID()}.db`;
    const db = await v14Db(filename);
    await runMigrations(db);
    await db.run("INSERT INTO journey_coaches (journey_id, code, classification, position) VALUES ('j1', 'GEN3', 'GEN', 6)");
    await expect(db.run("INSERT INTO journey_coaches (journey_id, code, classification, position) VALUES ('j1', 'X1', 'FIRST', 7)"))
      .rejects.toThrow(/CHECK/);
    const tables = await db.query(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND instr(sql, 'NON_AC') > 0`);
    expect(tables.map((t) => t.name).sort()).toEqual(['complaints', 'inspection_records', 'journey_coaches', 'passenger_feedback', 'train_coaches']);
    for (const t of tables) expect(t.sql, t.name).toContain("IN ('AC', 'NON_AC', 'GEN')");
    expect(await db.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    await db.close();

    const again = await createMemoryDb({ filename });
    expect(await getSchemaVersion(again)).toBe(17);
    await again.run('PRAGMA foreign_keys = OFF');
    await again.run("INSERT INTO train_coaches (train_id, code, classification, position) VALUES ('t1', 'GEN4', 'GEN', 9)");
    await expect(again.run("INSERT INTO train_coaches (train_id, code, classification, position) VALUES ('t1', 'X1', 'FIRST', 10)"))
      .rejects.toThrow(/CHECK/);
  });
});

describe('coach classes on screen', () => {
  it('takes the class from the coach code unless one is written after it', () => {
    expect(parseCoaches('B1, B2, S1, M1, HA1, GEN, UR2, BHJ, D1 GEN, GEN5 NON-AC, S9 AC, PC AC')).toEqual([
      { code: 'B1', classification: 'AC' }, { code: 'B2', classification: 'AC' }, { code: 'S1', classification: 'NON_AC' },
      { code: 'M1', classification: 'AC' }, { code: 'HA1', classification: 'AC' }, { code: 'GEN', classification: 'GEN' },
      { code: 'UR2', classification: 'GEN' }, { code: 'BHJ', classification: 'NON_AC' }, { code: 'D1', classification: 'GEN' },
      { code: 'GEN5', classification: 'NON_AC' }, { code: 'S9', classification: 'AC' }, { code: 'PC', classification: 'AC' }]);
    // Written back, a class appears only where the code does not already say it; the old " AC" still reads.
    expect(coachText(parseCoaches('B1 AC, S1, GEN, BHJ, D1 GEN, PC AC'))).toBe('B1, S1, GEN, BHJ, D1 GEN, PC AC');
    expect(inferClass('b5')).toBe('AC');
    expect(inferClass('BHJ')).toBeNull();
  });

  it('asks each class its own questions', () => {
    const bank = { questions: [
      { id: 'all', applies_ac: true, applies_non_ac: true, applies_gen: true },
      { id: 'ac', applies_ac: true, applies_non_ac: false, applies_gen: false },
      { id: 'gen', applies_ac: false, applies_non_ac: false, applies_gen: true },
    ] };
    const ids = (cls) => applicableQuestions(bank, cls).map((q) => q.id);
    expect(ids('AC')).toEqual(['all', 'ac']);
    expect(ids('NON_AC')).toEqual(['all']);
    expect(ids('GEN')).toEqual(['all', 'gen']);
  });

  it('counts General coaches apart from Non-AC ones', () => {
    const b = coachBreakdown(parseCoaches('GEN, GEN2, S2, S1, B1 AC'));
    expect([b.ac.total, b.nonAc.total, b.gen.total]).toEqual([1, 2, 2]);
    expect(b.gen.groups).toEqual([{ codes: 'GEN', label: 'General Unreserved (GS)', count: 2 }]);
  });
});

describe('every Indian Railways coach code (Commercial Circular 07 of 2021)', () => {
  it('knows AC, Non-AC and General coaches, and leaves service coaches to the person', () => {
    const want = {
      H1: 'AC', HA1: 'AC', HB1: 'AC', A2: 'AC', AB1: 'AC', B5: 'AC', M3: 'AC', G7: 'AC', C2: 'AC', E1: 'AC', J3: 'AC',
      K1: 'AC', EA1: 'AC', EV: 'AC', EV1: 'AC',
      S9: 'NON_AC', D4: 'NON_AC', SS1: 'NON_AC', F1: 'NON_AC', FC: 'NON_AC', DV1: 'NON_AC', VS: 'NON_AC',
      GEN: 'GEN', GEN3: 'GEN', GS: 'GEN', GN1: 'GEN', UR2: 'GEN', UNR: 'GEN', SLR: 'GEN', SLRD: 'GEN', SR: 'GEN',
      SRD: 'GEN', LRD: 'GEN', PWD: 'GEN', LDS: 'GEN',
      ENG: null, LOCO: null, PC: null, EOG: null, PWR: null, LPR: null, LUG: null, LV: null, PV: null, VP: null,
      VPU: null, HCP: null, TM: null, LR: null, BHJ: null,
    };
    for (const [code, cls] of Object.entries(want)) expect(inferClass(code), code).toBe(cls);
  });

  it('phone v16 gives coaches saved before the class their code now says', async () => {
    const db = await createMemoryDb({ migrate: false });
    for (const m of MIGRATIONS.filter((x) => x.version <= 15)) {
      const statements = m.prepare ? await m.prepare(db) : m.statements;
      await db.transaction([...statements.map((x) => (typeof x === 'string' ? { sql: x } : x)), { sql: `PRAGMA user_version = ${m.version}` }]);
    }
    await db.run('PRAGMA foreign_keys = OFF');
    for (const [code, cls, pos] of [['J1', 'NON_AC', 1], ['G1', 'NON_AC', 2], ['SLRD', 'NON_AC', 3], ['DV1', 'AC', 4], ['BHJ', 'AC', 5]]) {
      await db.run('INSERT INTO journey_coaches (journey_id, code, classification, position) VALUES (?, ?, ?, ?)', ['j1', code, cls, pos]);
    }
    expect(await runMigrations(db)).toMatchObject({ from: 15, to: 17, applied: [16, 17] });
    expect(await classes(db, 'journey_coaches')).toEqual({ J1: 'AC', G1: 'AC', SLRD: 'GEN', DV1: 'NON_AC', BHJ: 'AC' });
  });
});
