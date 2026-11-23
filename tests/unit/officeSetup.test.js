import { describe, expect, it } from 'vitest';
import {
  filterStations, initialPicks, runDaysLabel, setupBody, stationsWithoutTrains,
} from '../../src/pages/ops/masters/officeSetup.js';

describe('runDaysLabel', () => {
  it('reads like a timetable', () => {
    expect(runDaysLabel(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).toBe('Daily');
    expect(runDaysLabel(['thu', 'mon'])).toBe('Mon, Thu');
    expect(runDaysLabel(null)).toBe('Days not published');
  });
});

describe('setupBody', () => {
  const picks = {
    ADI: { 12833: { checked: true, coaches: 'b1 ac, s1' }, 19015: { checked: false, coaches: '' } },
    SBI: { 22959: { checked: false, coaches: '' } },
  };
  it('sends ticked trains with their coaches and leaves out stations with none', () => {
    expect(setupBody(['ADI', 'SBI'], picks)).toEqual({
      stations: [{ code: 'ADI', trains: [{ train_no: '12833', coaches: [{ code: 'B1', classification: 'AC' }, { code: 'S1', classification: 'NON_AC' }] }] }],
    });
  });
  it('names the stations that would plan nothing', () => {
    expect(stationsWithoutTrains(['ADI', 'SBI', 'MAN'], picks)).toEqual(['SBI', 'MAN']);
  });
});

describe('initialPicks', () => {
  it('ticks the trains already planned', () => {
    const setup = { stations: [{ code: 'ADI', train_nos: ['12833'] }, { code: 'MAN', train_nos: [] }] };
    expect(initialPicks(setup)).toEqual({ ADI: { 12833: { checked: true, coaches: '' } } });
  });
});

describe('filterStations', () => {
  const stations = [{ code: 'ADI', name: 'AHMEDABAD JN', city: 'Ahmedabad' }, { code: 'SBI', name: 'SABARMATI', city: 'Sabarmati' }];
  it('matches name, code or locality', () => {
    expect(filterStations(stations, 'sab').map((s) => s.code)).toEqual(['SBI']);
    expect(filterStations(stations, 'adi').map((s) => s.code)).toEqual(['ADI']);
    expect(filterStations(stations, '  ')).toHaveLength(2);
  });
});
