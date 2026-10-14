import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hebFromGreg, hebOccurrence, eventsInRange, parseHebYear, hebDateStr, toISO, normalizeHeb, hebMonthRange, birthNote, hebRangeStr } from '../lib/dates.js';

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

test('ל׳ בחודש חסר: מציינים יום קודם (כ״ט), התווית נשארת ל׳ עם הערה', () => {
  // חשוון 5786 חסר (29 יום)
  assert.equal(toISO(hebOccurrence(30, 8, 5786)), toISO(hebOccurrence(29, 8, 5786)));
  const [e] = eventsInRange({ h_day: 30, h_month: 8, h_year: 5750 }, new Date(2025, 10, 10), new Date(2025, 10, 30));
  assert.equal(toISO(e.date), '2025-11-20');
  assert.equal(e.label, 'ל׳ חשוון');
  assert.equal(e.note, 'השנה אין ל׳ חשוון — מציינים בכ״ט חשוון');
  // בשנה מלאה — בלי הערה
  const [f] = eventsInRange({ h_day: 30, h_month: 8, h_year: 5750 }, new Date(2026, 10, 1), new Date(2026, 10, 30));
  assert.equal(toISO(f.date), '2026-11-10');
  assert.equal(f.note, null);
  // ל׳ אדר א׳ בשנה פשוטה → כ״ט אדר
  const [g] = eventsInRange({ h_day: 30, h_month: 12, h_year: 5744 }, new Date(2026, 1, 15), new Date(2026, 3, 5));
  assert.equal(toISO(g.date), '2026-03-18');
  assert.equal(g.label, 'ל׳ אדר א׳');
});

test('אדר: התווית המקורית, הערה על התאריך של השנה', () => {
  const [a] = eventsInRange({ h_day: 14, h_month: 13, h_year: 5745 }, new Date(2027, 2, 1), new Date(2027, 3, 5));
  assert.equal(a.label, 'י״ד אדר');
  assert.equal(a.note, 'בשנה מעוברת מציינים בי״ד אדר ב׳');
  const [b] = eventsInRange({ h_day: 14, h_month: 13, h_year: 5744 }, new Date(2027, 2, 1), new Date(2027, 3, 5));
  assert.equal(b.label, 'י״ד אדר ב׳');
  assert.equal(b.note, null);
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

test('שבת וחג: שליחה יומית מוקדמת ליום החול שלפני וכוללת את ימי השבת/החג', async () => {
  const { dailyRange, weeklySendDay, isRestDay } = await import('../lib/dates.js');
  const r = (iso) => { const x = dailyRange(new Date(iso + 'T00:00')); return `${toISO(x.start)}..${toISO(x.end)}`; };
  assert.equal(r('2026-10-14'), '2026-10-14..2026-10-14'); // יום חול רגיל
  assert.equal(r('2026-10-16'), '2026-10-16..2026-10-17'); // שישי → כולל שבת
  assert.equal(r('2026-09-11'), '2026-09-11..2026-09-13'); // ערב ראש השנה (שבת+ראשון)
  assert.equal(r('2026-09-20'), '2026-09-20..2026-09-21'); // ערב יום כיפור
  assert.equal(r('2027-04-21'), '2027-04-21..2027-04-22'); // ערב פסח
  assert.ok(isRestDay(new Date(2026, 9, 3)));  // שמיני עצרת
  assert.ok(!isRestDay(new Date(2026, 8, 29))); // חול המועד
  // יום ראשון שהוא חג (ב׳ ראש השנה) → שבועי נשלח ביום שישי
  assert.equal(toISO(weeklySendDay(new Date(2026, 8, 13))), '2026-09-11');
  assert.equal(toISO(weeklySendDay(new Date(2026, 9, 18))), '2026-10-18');
});

test('יחידות SMS ומכסה', async () => {
  process.env.DATABASE_URL ||= 'postgres://unused';
  const { smsUnits, buildDailyMessage } = await import('../lib/sms.js');
  assert.equal(smsUnits('א'.repeat(70)), 1);
  assert.equal(smsUnits('א'.repeat(71)), 2);
  assert.equal(smsUnits('א'.repeat(134)), 2);
  assert.equal(smsUnits('א'.repeat(135)), 3);
  assert.equal(smsUnits('a'.repeat(160)), 1);
  const msg = buildDailyMessage([], { start: new Date(2026, 9, 16), end: new Date(2026, 9, 17) }, '');
  assert.equal(msg, '🎂 ימי הולדת היום ועד מוצאי שבת/חג (16.10–17.10)\nאין ימי הולדת בימים אלה.');
});

test('יומן: מיסוך מספרי טלפון', async () => {
  process.env.DATABASE_URL ||= 'postgres://unused';
  const { scrub } = await import('../lib/audit.js');
  assert.equal(scrub('נשלח ל-0521234567'), 'נשלח ל-\u206605•••••567\u2069');
  assert.equal(scrub('052-123-4567 נכשל'), '\u206605•••••567\u2069 נכשל');
  assert.equal(scrub('3 יחידות'), '3 יחידות');
});

test('ייבוא מאקסל: טבלה, זיהוי עמודות ותאריכים', async () => {
  process.env.DATABASE_URL ||= 'postgres://unused';
  const { splitTable, guessMapping, parseRow, parseDateCell, dupKey } = await import('../lib/import.js');
  const rows = splitTable('שם פרטי\tשם משפחה\tנייד\tתאריך לידה\nדוד\tכהן\t052-1234567\t14/03/1990\nשרה\tלוי\t\tה\' חשוון תש"נ\n');
  const g = guessMapping(rows);
  assert.deepEqual(g, { hasHeader: true, mapping: ['first_name', 'last_name', 'phone', 'date'] });
  const a = parseRow(rows[1], g.mapping).value;
  assert.equal(a.g_date, '1990-03-14');
  const b = parseRow(rows[2], g.mapping).value;
  assert.deepEqual([b.h_day, b.h_month, b.h_year, b.g_date], [5, 8, 5750, null]);
  // בלי כותרות, CSV, שם מלא בעמודה אחת
  const r2 = splitTable('יוסי לוי,0521112233,12/12/1985\nרחל כהן,0529998888,3.7.85\n');
  assert.deepEqual(guessMapping(r2).mapping, ['full_name', 'phone', 'date']);
  assert.equal(parseDateCell('32946').g_date, '1990-03-14'); // מספר סידורי של אקסל
  assert.deepEqual(parseDateCell('כ"ט באדר א\' תשמ"ד'), { date_type: 'h', h_day: '29', h_month: '12', h_year: 'תשמ"ד' });
  assert.ok(parseRow(['', 'כהן', '', '1.1.2000'], ['first_name', 'last_name', 'phone', 'date']).error);
  assert.equal(dupKey({ phone: '+972-52-1234567', first_name: 'x' }), dupKey({ phone: '0521234567', first_name: 'y' }));
});

test('תזכורת אישית על מקורב: יום השליחה, כולל דחייה לפני שבת/חג', async () => {
  process.env.DATABASE_URL ||= 'postgres://unused';
  const { contactReminderDue, buildContactReminder } = await import('../lib/sms.js');
  const D = (y, m, d) => new Date(y, m - 1, d);
  // יום הולדת ביום ה' 22.10.2026, תזכורת 2 ימים לפני → שלישי 20.10
  assert.ok(contactReminderDue(2, D(2026, 10, 22), D(2026, 10, 20)));
  assert.ok(!contactReminderDue(2, D(2026, 10, 22), D(2026, 10, 19)));
  // תזכורת ביום עצמו, יום ההולדת בשבת 24.10 → נשלחת בשישי 23.10
  assert.ok(contactReminderDue(0, D(2026, 10, 24), D(2026, 10, 23)));
  // תזכורת יום לפני, יום ההולדת ב-ב׳ ראש השנה (ראשון 13.9.2026) → יום התזכורת שבת → נשלחת בשישי 11.9
  assert.ok(contactReminderDue(1, D(2026, 9, 13), D(2026, 9, 11)));
  const msg = buildContactReminder([{ date: D(2026, 10, 22), label: 'י״א חשוון', age: 40, name: 'דוד כהן', contact: { phone: '052-1234567' } }], D(2026, 10, 20), '');
  assert.equal(msg, '🔔 תזכורת יום הולדת:\nדוד כהן, 40 — בעוד 2 ימים, חמישי י״א חשוון');
});

test('חשבון הדגמה: 10 מקורבים תקינים, רובם היום / ב-30 הימים הקרובים', async () => {
  process.env.DATABASE_URL ||= 'postgres://unused';
  const { demoSeed } = await import('../lib/demo.js');
  const { parseBirth } = await import('../lib/person.js');
  const { nextBirthday } = await import('../lib/dates.js');
  for (const today of [new Date(2026, 9, 14), new Date(2027, 1, 20), new Date(2027, 2, 15), new Date(2026, 11, 31)]) {
    const people = demoSeed(today).map((p) => parseBirth(p));
    assert.equal(people.length, 10);
    assert.ok(people.every((p) => p.value), JSON.stringify(people.filter((p) => p.error)));
    const days = people.map((p) => Math.round((nextBirthday(p.value, today).date - today) / 86400000));
    assert.ok(days.filter((d) => d === 0).length >= 2, String(days));
    assert.ok(days.filter((d) => d < 30).length >= 6, String(days));
  }
});

test('פנייה: הרב / הרבנית, בלי תואר, ובלי להכפיל תואר קיים', async () => {
  const { displayName, parseAddress, g } = await import('../lib/address.js');
  assert.equal(displayName({ name: 'יוסי כהן', gender: 'm', use_title: true }), 'הרב יוסי כהן');
  assert.equal(displayName({ name: 'חיה כהן', gender: 'f', use_title: true }), 'הרבנית חיה כהן');
  assert.equal(displayName({ name: 'חיה כהן', gender: 'f', use_title: false }), 'חיה כהן');
  assert.equal(displayName({ name: 'הרב יוסי כהן', gender: 'm', use_title: true }), 'הרב יוסי כהן');
  assert.deepEqual(parseAddress('f1'), { gender: 'f', use_title: true });
  assert.deepEqual(parseAddress('xx'), { gender: 'm', use_title: true });
  assert.equal(g({ gender: 'f' }, 'משתמש', 'משתמשת'), 'משתמשת');
});

test('birthNote: הסבר רק לתאריכים שזזים', () => {
  assert.equal(birthNote(3, 7, 5780), null);
  assert.equal(birthNote(29, 8, 5785), null);
  assert.match(birthNote(30, 8, 5785), /בכ״ט חשוון/);
  assert.match(birthNote(30, 9, null), /בכ״ט כסלו/);
  assert.match(birthNote(14, 12, 5784), /אדר א׳.*בי״ד אדר$/);
  assert.match(birthNote(14, 13, 5784), /אדר ב׳/);
  assert.match(birthNote(14, 13, 5785), /בשנה מעוברת — בי״ד אדר ב׳/);
});

test('hebRangeStr: טווח עברי', () => {
  assert.equal(hebRangeStr(new Date(2026, 9, 11), new Date(2026, 9, 17)), 'ל׳ תשרי–ו׳ חשוון');
  assert.equal(hebRangeStr(new Date(2026, 9, 20), new Date(2026, 9, 24)), 'ט׳–י״ג חשוון');
  assert.match(hebRangeStr(new Date(2026, 8, 1), new Date(2026, 8, 30)), /תשפ״ו–.*תשפ״ז$/);
});

test('eventsInRange: טווח ארוך שנוגע בשלוש שנים עבריות', () => {
  // 1.9.2025 (ט׳ אלול תשפ״ה) עד 31.8.2026 — כולל כל תשפ״ו
  const ev = eventsInRange({ h_day: 1, h_month: 1, h_year: null }, new Date(2025, 8, 1), new Date(2026, 7, 31));
  assert.equal(ev.length, 1);
});

test('parseBirth: שנת לידה עברית עתידית נדחית', async () => {
  const { parseBirth } = await import('../lib/person.js');
  assert.ok(parseBirth({ date_type: 'h', h_day: '5', h_month: '7', h_year: '5790' }).error);
  assert.equal(parseBirth({ date_type: 'h', h_day: '5', h_month: '7', h_year: '5750' }).value.h_year, 5750);
});

test('ייבוא: ל׳ אדר ב׳ הוא שגיאה, ולא הופך בשקט לאדר א׳', async () => {
  const { parseDateCell } = await import('../lib/import.js');
  assert.ok(parseDateCell("ל' אדר ב' תשפ\"ד").error);
  assert.equal(parseDateCell('ל אדר א תשפד').h_month, '12');
  assert.equal(parseDateCell('כט אדר ב תשפד').h_month, '13');
});
