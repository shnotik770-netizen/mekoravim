// שחזור מגיבוי. מחליף את כל הנתונים הקיימים!
//   node scripts/restore.mjs --list             רשימת הגיבויים
//   CONFIRM=yes node scripts/restore.mjs latest שחזור מהגיבוי האחרון
//   CONFIRM=yes node scripts/restore.mjs backups/2026-10-13T01-17-00Z.json.gz
import { pool } from '../lib/db.js';
import { restore, unpack, store, TABLES } from '../lib/backup.js';

const arg = process.argv[2];
try {
  const s = store();
  const keys = await s.list();
  if (!arg || arg === '--list') {
    console.log(keys.length ? keys.join('\n') : 'אין גיבויים');
  } else {
    const key = arg === 'latest' ? keys.at(-1) : arg;
    if (!key) throw new Error('לא נמצא גיבוי');
    if (process.env.CONFIRM !== 'yes') throw new Error(`השחזור ימחק את כל הנתונים הנוכחיים ויחליף אותם ב-${key}. להרצה: CONFIRM=yes`);
    const data = unpack(await s.get(key));
    await restore(data);
    console.log(`שוחזר מ-${key} (נוצר ${data.created_at}): ` + TABLES.map((t) => `${t}=${(data.tables[t] || []).length}`).join(' '));
  }
} catch (e) {
  console.error('השחזור נכשל:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
