import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResponse, diffDirection, buildAlertMessages, monthList, todayKst, fmtDate } from '../scripts/lib.mjs';

// Shape copied from a real bonusSeatView response (ICN-LAX, 2027-03), trimmed.
const sample = {
  departureAirport: 'ICN', arrivalAirport: 'LAX',
  flightList: [
    { departureDate: '20270301', flightDetailList: [
      { departureTime: '14:30', flightNumber: 'KE017', availableSeat: true, bookingClass: 'X', frontBookingClass: 'E' },
      { departureTime: '14:30', flightNumber: 'KE017', availableSeat: false, bookingClass: 'O', frontBookingClass: 'P' },
      { departureTime: '14:30', flightNumber: 'KE017', availableSeat: false, bookingClass: 'Z', frontBookingClass: 'U' },
      { departureTime: '14:30', flightNumber: 'KE017', availableSeat: false, bookingClass: 'A', frontBookingClass: 'F' },
      { departureTime: '19:40', flightNumber: 'KE011', availableSeat: true, bookingClass: 'X', frontBookingClass: 'E' },
      { departureTime: '19:40', flightNumber: 'KE011', availableSeat: false, bookingClass: 'A', frontBookingClass: 'F' },
    ] },
    { departureDate: '20270302', flightDetailList: [
      { departureTime: '14:30', flightNumber: 'KE017', availableSeat: true, bookingClass: 'Z', frontBookingClass: 'U' },
      { departureTime: '14:30', flightNumber: 'KE017', availableSeat: true, bookingClass: 'A', frontBookingClass: 'F' },
      { departureTime: '14:30', flightNumber: 'KE017', availableSeat: true, bookingClass: 'O', frontBookingClass: 'P' },
    ] },
    { departureDate: '20270303', flightDetailList: [] },
  ],
};

test('normalizeResponse keeps flights and open classes in F,P,U,E order', () => {
  const d = normalizeResponse(sample);
  assert.deepEqual(d['20270301'], [['KE017', '14:30', 'E'], ['KE011', '19:40', 'E']]);
  assert.deepEqual(d['20270302'], [['KE017', '14:30', 'FPU']]);
  assert.deepEqual(d['20270303'], []);
});

test('normalizeResponse rejects unexpected shapes', () => {
  assert.throws(() => normalizeResponse({ error: 'x' }));
});

test('diffDirection: first run produces no alerts', () => {
  const next = normalizeResponse(sample);
  assert.deepEqual(diffDirection(undefined, next, { watch: ['F', 'P'], today: '20261107' }), []);
});

test('diffDirection: only newly opened watched classes, future dates, fetched months', () => {
  const prev = { '20270302': [['KE017', '14:30', 'U']], '20270301': [['KE017', '14:30', 'E']] };
  const next = normalizeResponse(sample);
  const got = diffDirection(prev, next, { watch: ['F', 'P'], today: '20261107', fetchedMonths: new Set(['202703']) });
  assert.deepEqual(got, [
    { date: '20270302', flight: 'KE017', time: '14:30', cls: 'F' },
    { date: '20270302', flight: 'KE017', time: '14:30', cls: 'P' },
  ]);
  // Month not fetched this run -> ignored
  assert.deepEqual(diffDirection(prev, next, { watch: ['F', 'P'], today: '20261107', fetchedMonths: new Set(['202704']) }), []);
  // Date inside prev's range but missing from prev -> no baseline, no alert
  const prevGap = { '20270301': [['KE017', '14:30', 'E']], '20270310': [] };
  assert.deepEqual(diffDirection(prevGap, next, { watch: ['F', 'P'], today: '20261107' }), []);
  // Date after prev's last date -> newly released, alerts
  const prevOld = { '20270301': [['KE017', '14:30', 'E']] };
  assert.equal(diffDirection(prevOld, next, { watch: ['F', 'P'], today: '20261107' }).length, 2);
  // Past dates ignored
  assert.deepEqual(diffDirection(prev, next, { watch: ['F', 'P'], today: '20270303' }), []);
});

test('buildAlertMessages merges classes per flight and splits long output', () => {
  const items = [
    { date: '20270302', flight: 'KE017', time: '14:30', cls: 'F' },
    { date: '20270302', flight: 'KE017', time: '14:30', cls: 'P' },
  ];
  const msgs = buildAlertMessages([{ fromName: '서울/인천', toName: '로스앤젤레스', items }], { pageUrl: 'https://x.github.io/y/' });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /27\/03\/02\(화\) KE017 14:30 · 일등석, 프레스티지/);
  assert.match(msgs[0], /https:\/\/x\.github\.io\/y\//);

  const many = Array.from({ length: 40 }, (_, i) => ({ fromName: 'A' + i, toName: 'B', items: Array.from({ length: 20 }, (_, j) => ({ date: '202703' + String(j + 1).padStart(2, '0'), flight: 'KE0' + i, time: '10:00', cls: 'P' })) }));
  const split = buildAlertMessages(many, {});
  assert.ok(split.length > 1 && split.length <= 4, `count ${split.length}`);
  assert.match(split.at(-1), /생략/);
  for (const m of split) assert.ok(m.length <= 4096, `len ${m.length}`);
  assert.deepEqual(buildAlertMessages([], {}), []);
});

test('date helpers use KST', () => {
  const t = new Date('2026-11-30T16:00:00Z'); // 2026-12-01 01:00 KST
  assert.equal(todayKst(t), '20261201');
  assert.deepEqual(monthList(t, 3), ['202612', '202701', '202702']);
  assert.equal(fmtDate('20270101'), '27/01/01(금)');
});
