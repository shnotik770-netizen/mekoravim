import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hebFromGreg, hebOccurrence, eventsInRange, parseHebYear, hebDateStr, toISO } from '../lib/dates.js';

test('המרה מלועזי לעברי, כולל אחרי השקיעה', () => {
  assert.deepEqual(hebFromGreg(new Date(1990, 9, 20), false), { day: 1, month: 8, year: 5751 });
  assert.deepEqual(hebFromGreg(new Date(1990, 9, 20), true), { day: 2, month: 8, year: 5751 });
});

test('אדר בשנה פשוטה נשמר כ-13 וחל באדר ב׳ בשנה מעוברת', () => {
  const h = hebFromGreg(new Date(2025, 2, 14), false); // 14 Adar 5785 (פשוטה)
  assert.deepEqual(h, { day: 14, month: 13, year: 5785 });
  assert.equal(toISO(hebOccurrence(14, 13, 5787)), '2027-03-23'); // פורים 5787 = 14 אדר ב׳
  assert.equal(toISO(hebOccurrence(14, 12, 5787)), '2027-02-21'); // 14 אדר א׳
  assert.equal(toISO(hebOccurrence(14, 12, 5786)), '2026-03-03'); // אדר א׳ בשנה פשוטה → אדר
});

test('30 בחודש חסר עובר ל-א׳ בחודש הבא', () => {
  // חשוון 5786 חסר (29 יום)
  assert.equal(toISO(hebOccurrence(30, 8, 5786)), toISO(hebOccurrence(1, 9, 5786)));
});

test('אירועים בטווח וגיל', () => {
  const evs = eventsInRange({ g_date: '1990-10-20', h_day: 1, h_month: 8, h_year: 5751 }, new Date(2026, 9, 11), new Date(2026, 9, 31));
  assert.deepEqual(evs.map((e) => [e.kind, toISO(e.date), e.age]), [['hebrew', '2026-10-12', 36], ['gregorian', '2026-10-20', 36]]);
  assert.equal(eventsInRange({ g_date: '1990-10-20' }, new Date(2026, 9, 11), new Date(2026, 9, 31), 'hebrew').length, 0);
});

test('טווח שחוצה שנה', () => {
  const evs = eventsInRange({ g_date: '2000-01-02' }, new Date(2026, 11, 28), new Date(2027, 0, 3));
  assert.deepEqual(evs.map((e) => toISO(e.date)), ['2027-01-02']);
});

test('29 בפברואר', () => {
  const evs = eventsInRange({ g_date: '2000-02-29' }, new Date(2027, 1, 1), new Date(2027, 1, 28), 'gregorian');
  assert.equal(toISO(evs[0].date), '2027-02-28');
});

test('פענוח שנה עברית', () => {
  assert.equal(parseHebYear('תש"נ'), 5750);
  assert.equal(parseHebYear('ה׳תש״נ'), 5750);
  assert.equal(parseHebYear('5750'), 5750);
  assert.equal(parseHebYear(''), null);
  assert.ok(Number.isNaN(parseHebYear('abc')));
  assert.equal(hebDateStr(15, 7, 5750), 'ט״ו תשרי תש״נ');
});
