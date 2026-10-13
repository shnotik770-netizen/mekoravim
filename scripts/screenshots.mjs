// יוצר שליח דמו עם נתונים לדוגמה ומצלם מסכים ל-public/img (לדף הבית).
// הרצה: שרת פועל מקומית על DB ריק/לבדיקה, ואז:
//   BASE=http://localhost:3456 ADMIN_PASSWORD=... node scripts/screenshots.mjs
// דורש playwright (לא תלות של הפרויקט).
import { chromium } from 'playwright';

const B = process.env.BASE || 'http://localhost:3000';
const OUT = new URL('../public/img/', import.meta.url).pathname;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2, locale: 'he-IL' });
const wide = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1, locale: 'he-IL' });
const page = await ctx.newPage();
const post = (url, form) => page.request.post(B + url, { form, maxRedirects: 0 });

await post('/admin/login', { password: process.env.ADMIN_PASSWORD });
await post('/admin/shluchim', { name: 'בית חב"ד לדוגמה', with_code: 'no' });
await page.goto(B + '/admin');
const slug = (await page.locator('code.copy').first().textContent()).split('/s/')[1].trim();
const base = `/s/${slug}`;

// מקורבים לדוגמה — תאריכים עבריים סביב החודש הנוכחי
const { HDate } = await import('@hebcal/core');
const now = new HDate(new Date());
const people = [
  ['יוסי', 'אברהמי', 0, 1, 5745], ['מיכל', 'ברק', 1, 2, 5752], ['אבי', 'גולן', 3, 1, null],
  ['רונית', 'דהן', 4, 3, 5760], ['שמעון', 'הלוי', 10, 1, 5738], ['נועה', 'וקנין', 18, 2, 5755],
  ['דניאל', 'זילבר', 25, 4, 5770], ['אליהו', 'חזן', -1, 1, 5749],
];
const cats = [...new Set((await (await page.request.get(B + base + '/settings')).text()).match(/name="id" value="(\d+)"/g).map((m) => m.match(/\d+/)[0]))];
for (const [first, last, offset, cat, year] of people) {
  const d = new HDate(now.abs() + offset);
  let m = d.getMonth();
  if (m === 12 && !d.isLeapYear()) m = 13;
  await post(base + '/contacts/new', {
    first_name: first, last_name: last, phone: '05' + Math.floor(10000000 + Math.random() * 89999999),
    date_type: 'h', h_day: String(d.getDate()), h_month: String(m), h_year: year ? String(year) : '', category_id: cats[cat - 1],
  });
}
// בן משפחה, יצירת קשר וקישור רישום
await post(base + '/contacts/1/family', { relation: 'בת', first_name: 'שירה', date_type: 'h', h_day: String(new HDate(now.abs() + 2).getDate()), h_month: String(new HDate(now.abs() + 2).getMonth()), h_year: 'תשע"ה' });
await post(base + '/contacts/8/log', { note: 'ברכתי בטלפון' });
await post(base + '/contacts/1/log', { note: 'שלחתי ברכה בוואטסאפ' });
await post(base + '/links', { name: 'שיעור שבועי', category_id: cats[1] });
await post(base + '/links', { name: 'קבוצת הוואטסאפ של הקהילה', category_id: '' });

await page.goto(B + base); // ניקוי הודעת flash
const shot = async (url, file, before) => {
  await page.goto(B + url);
  if (before) await before();
  await page.screenshot({ path: OUT + file, fullPage: false });
};
await shot(base, 'dashboard.png');
await shot(base + '/contacts/1', 'contact.png');
await shot(base + '/links', 'links.png');
const token = (await page.locator('code.copy').first().textContent()).split('/r/')[1].trim();
await shot('/r/' + token, 'register.png', async () => {
  await page.fill('input[name=first_name]', 'משה');
  await page.fill('input[name=last_name]', 'כהן');
  await page.fill('input[name=phone]', '052-1234567');
  await page.selectOption('select[name=h_day]', '15');
  await page.selectOption('select[name=h_month]', '7');
  await page.fill('input[name=h_year]', 'תש"נ');
});
// דשבורד בדסקטופ
const wp = await wide.newPage();
await wp.goto(B + base);
await wp.screenshot({ path: OUT + 'dashboard-desktop.png', fullPage: false });
await browser.close();
console.log('saved to', OUT);
