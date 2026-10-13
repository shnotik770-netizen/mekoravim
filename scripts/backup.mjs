// גיבוי יומי — רץ כשירות cron נפרד ב-Railway: node scripts/backup.mjs
import { pool } from '../lib/db.js';
import { dump, pack, store, keyFor, expired, TABLES } from '../lib/backup.js';

const KEEP_DAYS = parseInt(process.env.BACKUP_KEEP_DAYS || '30', 10);

try {
  const s = store();
  const data = await dump();
  const body = pack(data);
  const key = keyFor();
  await s.put(key, body);
  const counts = TABLES.map((t) => `${t}=${data.tables[t].length}`).join(' ');
  console.log(`גיבוי נשמר: ${key} (${Math.round(body.length / 1024)}KB) ${counts}`);
  const old = expired(await s.list(), KEEP_DAYS);
  await s.remove(old);
  if (old.length) console.log(`נמחקו ${old.length} גיבויים ישנים מ-${KEEP_DAYS} ימים`);
} catch (e) {
  console.error('הגיבוי נכשל:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
