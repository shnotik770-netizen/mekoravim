import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hebFromGreg, hebOccurrence, eventsInRange, parseHebYear, hebDateStr, toISO, normalizeHeb, hebMonthRange } from '../lib/dates.js';

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

test('אירועים בטווח וגיל — עברי בלבד', () => {
  const evs = eventsInRange({ g_date: '1990-10-20', h_day: 1, h_month: 8, h_year: 5751 }, new Date(2026, 9, 11), new Date(2026, 9, 31));
  assert.deepEqual(evs.map((e) => [toISO(e.date), e.age, e.label]), [['2026-10-12', 36, 'א׳ חשוון']]);
});

test('טווח שחוצה ראש השנה', () => {
  const evs = eventsInRange({ h_day: 1, h_month: 7 }, new Date(2026, 8, 1), new Date(2026, 8, 30));
  assert.deepEqual(evs.map((e) => toISO(e.date)), ['2026-09-12']);
});

test('אימות תאריך עברי (כללי קאפיטל)', () => {
  assert.ok(normalizeHeb(30, 10, null).error); // ל׳ טבת — אף פעם
  assert.ok(normalizeHeb(30, 2, 5750).error); // ל׳ אייר
  assert.deepEqual(normalizeHeb(30, 13, null).value, { day: 30, month: 12, year: null }); // ל׳ אדר = אדר א׳
  assert.ok(normalizeHeb(30, 13, 5785).error); // ל׳ אדר בשנה פשוטה
  assert.deepEqual(normalizeHeb(14, 12, 5785).value, { day: 14, month: 13, year: 5785 }); // אדר א׳ בשנה פשוטה → אדר
  assert.ok(normalizeHeb(30, 8, 5786).error); // חשוון 5786 חסר
  assert.deepEqual(normalizeHeb(30, 8, 5787).value, { day: 30, month: 8, year: 5787 });
});

test('החודש העברי הנוכחי', () => {
  const m = hebMonthRange(new Date(2026, 9, 13));
  assert.equal(toISO(m.start), '2026-10-12');
  assert.equal(m.name, 'חשוון תשפ״ז');
});

test('פענוח שנה עברית', () => {
  assert.equal(parseHebYear('תש"נ'), 5750);
  assert.equal(parseHebYear('ה׳תש״נ'), 5750);
  assert.equal(parseHebYear('5750'), 5750);
  assert.equal(parseHebYear(''), null);
  assert.ok(Number.isNaN(parseHebYear('abc')));
  assert.equal(hebDateStr(15, 7, 5750), 'ט״ו תשרי תש״נ');
});

test('הודעת SMS שבועית', async () => {
  process.env.DATABASE_URL ||= 'postgres://unused';
  const { buildWeeklyMessage, normalizePhone } = await import('../lib/sms.js');
  const week = { start: new Date(2026, 9, 11), end: new Date(2026, 9, 17) };
  const c = { first_name: 'משה', last_name: 'כהן' };
  const msg = buildWeeklyMessage('x', [
    { date: new Date(2026, 9, 12), label: 'א׳ חשוון', age: 36, name: 'משה כהן', contact: c, member: null },
    { date: new Date(2026, 9, 16), label: 'ה׳ חשוון', age: 12, name: 'שרה', contact: c, member: { first_name: 'שרה', relation: 'בת' } },
  ], week, 'https://x/s/abc');
  assert.equal(msg, '🎂 ימי הולדת השבוע (11.10–17.10)\nשני א׳ חשוון: משה כהן, 36\nשישי ה׳ חשוון: שרה (בת של משה כהן), 12\nhttps://x/s/abc');
  assert.equal(normalizePhone('+972-52-123-4567'), '0521234567');
  assert.equal(normalizePhone('03-1234567'), null);
});
