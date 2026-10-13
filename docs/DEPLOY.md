# פריסה ב-Railway — שלב אחר שלב

> ערכים סודיים (סיסמאות, טוקנים) מזינים **רק** בממשק של Railway. לא בקוד, לא בגיט ולא בצ׳אט.

## 1. פרויקט ושירותים
1. railway.com → **New Project** → **Deploy from GitHub repo** → `shnotik770-netizen/mekoravim`.
2. בשירות שנוצר: **Settings → Source → Branch** = הענף שממנו פורסים (`main` אחרי שייפתח, או `ccr-3c16c70c-bz6ck6`).
3. בתוך הפרויקט: **+ Create → Database → Add PostgreSQL**.
4. בשירות האפליקציה: **Settings → Deploy → Replicas = 1** (הגבלות הקצב נשמרות בזיכרון של מופע אחד).

## 2. משתני סביבה (בשירות האפליקציה, לא ב-Postgres)
שירות האפליקציה → לשונית **Variables** → **+ New Variable** לכל שורה:

| שם | ערך | הערות |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | להקליד בדיוק כך — Railway מחליף בכתובת האמיתית. אם שירות ה-DB נקרא אחרת, להחליף את `Postgres` בשם שלו |
| `ADMIN_PASSWORD` | סיסמה שתבחר | 8 תווים לפחות. 8 ספרות מספיק, אבל לא רצף (`12345678`) ולא תו חוזר (`11111111`) — אחרת השרת לא יעלה |
| `SESSION_SECRET` | מחרוזת אקראית ארוכה | בעורך המשתנים יש אפשרות ליצור ערך אקראי, או בטרמינל: `openssl rand -base64 48`. 32 תווים לפחות |
| `NODE_ENV` | `production` | עוגיות מאובטחות ואכיפת חוזק סיסמה |
| `PUBLIC_URL` | הכתובת שתקבל בשלב 3 | בלי `/` בסוף, למשל `https://mekoravim-production.up.railway.app` |

בהמשך, כשיהיה טוקן של ימות המשיח:

| שם | ערך |
|---|---|
| `YEMOT_TOKEN` | מפתח ה-API מחשבון ימות המשיח (`apik_...`) |
| `YEMOT_SMS_FROM` | (רשות) מזהה שולח שמאושר אצלם |

אחרי שמירה Railway פורס מחדש אוטומטית.

## 3. כתובת
שירות האפליקציה → **Settings → Networking → Generate Domain**. מעתיקים את הכתובת ל-`PUBLIC_URL` (שלב 2).
דומיין משלך — בשלב מאוחר יותר.

## 4. גיבוי
גיבוי מובנה של Railway דורש תוכנית Pro. במקומו יש גיבוי יומי חינמי — סעיף 6.

## 5. בדיקה
1. `<הכתובת>/health` מחזיר `ok`.
2. בלוגים של הפריסה (**Deployments → View logs**) מופיע `listening on ...`.
   אם מופיע `ADMIN_PASSWORD חלשה מדי` או `SESSION_SECRET קצר מדי` — לתקן את המשתנה.
3. `<הכתובת>/admin/login` → כניסה → יצירת שליח ניסיון → כניסה לקישור שלו → יצירת קישור רישום → רישום מהטלפון.
4. אחרי שמוגדר `YEMOT_TOKEN`: בהגדרות השליח → נייד → "שליחת הודעת ניסיון עכשיו".

## 6. גיבוי יומי (חינמי — בלי תוכנית Pro)
שירות cron נפרד שמייצא את כל הנתונים פעם ביום לקובץ דחוס ב-bucket של Railway, ושומר 30 יום (תמיד לפחות 3 אחרונים).

**מה עושים ב-Railway:**
1. בפרויקט: **+ Create → Bucket**, בשם `backups`.
2. **+ Create → GitHub Repo** → `shnotik770-netizen/mekoravim`, שם השירות `backup`, ענף כמו של web.
3. בשירות `backup` → **Settings → Config-as-code → Railway Config File** = `railway.backup.json`
   (הקובץ קובע: הרצת `node scripts/backup.mjs` כל לילה ב-01:17 UTC ≈ 3–4 בלילה בישראל, בלי בדיקת health).
4. בשירות `backup` → **Variables**:

| שם | ערך |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `BUCKET` | `${{backups.BUCKET}}` |
| `ENDPOINT` | `${{backups.ENDPOINT}}` |
| `REGION` | `${{backups.REGION}}` |
| `ACCESS_KEY_ID` | `${{backups.ACCESS_KEY_ID}}` |
| `SECRET_ACCESS_KEY` | `${{backups.SECRET_ACCESS_KEY}}` |

(אם ה-bucket נקרא אחרת — להחליף `backups` בשם שלו.)

**בדיקה:** בשירות backup → **Deployments → Run now** (או לחכות ללילה) → בלוג: `גיבוי נשמר: backups/...`.

**שחזור** (מחליף את כל הנתונים!): `node scripts/restore.mjs --list` לרשימה, ואז `CONFIRM=yes node scripts/restore.mjs latest`.
