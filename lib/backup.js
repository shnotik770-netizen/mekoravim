// גיבוי ושחזור של כל הנתונים: ייצוא כל הטבלאות ל-JSON דחוס (gzip).
// היעד: bucket תואם S3 (ב-Railway), או תיקייה מקומית (BACKUP_DIR) לבדיקות.
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import pg from 'pg';
import { pool } from './db.js';

// חותמות זמן נשמרות כטקסט כמו שהן (כולל מיקרו-שניות) — Date של JS מאבד דיוק
const RAW = new Set([1114, 1184]);
const types = { getTypeParser: (oid, fmt) => (RAW.has(oid) ? (v) => v : pg.types.getTypeParser(oid, fmt)) };

// לפי סדר התלויות (מפתחות זרים) — כך גם משחזרים
export const TABLES = ['shluchim', 'categories', 'reg_links', 'contacts', 'family_members', 'contact_log'];
const PREFIX = 'backups/';

export async function dump() {
  const client = await pool.connect();
  try {
    // תמונת מצב עקבית של כל הטבלאות
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = {};
    for (const t of TABLES) tables[t] = (await client.query({ text: `SELECT * FROM ${t} ORDER BY id`, types })).rows;
    await client.query('COMMIT');
    return { version: 1, created_at: new Date().toISOString(), tables };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function restore(data) {
  if (data?.version !== 1 || !data.tables) throw new Error('קובץ גיבוי לא תקין');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    for (const t of TABLES) {
      for (const row of data.tables[t] || []) {
        const cols = Object.keys(row);
        const vals = cols.map((c) => row[c]);
        await client.query(
          `INSERT INTO ${t} (${cols.map((c) => `"${c.replace(/"/g, '')}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
          vals);
      }
      // המספור האוטומטי ממשיך אחרי ה-id הגבוה ביותר
      await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT max(id) FROM ${t}), 0) + 1, false)`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export const pack = (data) => zlib.gzipSync(Buffer.from(JSON.stringify(data)));
export const unpack = (buf) => JSON.parse(zlib.gunzipSync(buf).toString('utf8'));

/* ---------------- יעדי אחסון ---------------- */

function s3Store() {
  const { BUCKET, ENDPOINT, REGION, ACCESS_KEY_ID, SECRET_ACCESS_KEY } = process.env;
  if (!BUCKET || !ENDPOINT || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) return null;
  const s3 = new S3Client({
    endpoint: ENDPOINT, region: REGION || 'auto', forcePathStyle: process.env.BUCKET_PATH_STYLE === 'true',
    credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
  });
  return {
    async put(key, body) { await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'application/gzip' })); },
    async get(key) { const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })); return Buffer.from(await r.Body.transformToByteArray()); },
    async list() {
      const out = [];
      let token;
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token }));
        for (const o of r.Contents || []) out.push(o.Key);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out.sort();
    },
    async remove(keys) { if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })) } })); },
  };
}

function dirStore(dir) {
  const p = (key) => path.join(dir, key);
  return {
    async put(key, body) { await fs.mkdir(path.dirname(p(key)), { recursive: true }); await fs.writeFile(p(key), body); },
    async get(key) { return fs.readFile(p(key)); },
    async list() { try { return (await fs.readdir(p(PREFIX))).map((f) => PREFIX + f).sort(); } catch { return []; } },
    async remove(keys) { for (const k of keys) await fs.rm(p(k), { force: true }); },
  };
}

export function store() {
  if (process.env.BACKUP_DIR) return dirStore(process.env.BACKUP_DIR);
  const s = s3Store();
  if (!s) throw new Error('לא מוגדר יעד גיבוי (BUCKET/ENDPOINT/ACCESS_KEY_ID/SECRET_ACCESS_KEY או BACKUP_DIR)');
  return s;
}

// שם קובץ לפי תאריך ושעה (UTC), כך שמיון אלפביתי = מיון כרונולוגי
export const keyFor = (d = new Date()) => `${PREFIX}${d.toISOString().slice(0, 19).replace(/:/g, '-')}Z.json.gz`;

// מוחק גיבויים ישנים מ-keepDays ימים (תמיד משאיר לפחות את 3 האחרונים)
export function expired(keys, keepDays, now = new Date()) {
  const cutoff = now.getTime() - keepDays * 86400000;
  const sorted = [...keys].sort();
  return sorted.slice(0, Math.max(0, sorted.length - 3)).filter((k) => {
    const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z/.exec(k);
    return m && Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) < cutoff;
  });
}
