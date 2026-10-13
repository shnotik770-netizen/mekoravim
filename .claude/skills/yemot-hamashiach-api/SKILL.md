---
name: yemot-hamashiach-api
description: Integration guide for the Yemot HaMashiach / Call2All API (ימות המשיח, call2all.co.il) — sending SMS (SendSms, bulk, sender ID), reading SMS logs (GetIncomingSms, GetSmsOutLog), generic web-service calls, and building IVR phone extensions with the type=api module (id_list_message, read=, ApiPhone, hangup, credit_card via Nedarim Plus). Use whenever code sends SMS to Israeli phones through Yemot/Call2All, reads SMS replies, builds a phone extension (שלוחה) that calls a server, or the user mentions ימות המשיח, call2all, Yemot, IVR, שלוחה, סמס, SendSms, or a YEMOT_/CALL2ALL_ env var. Based on working code from the user's own projects.
---

# ימות המשיח (Call2All) — API

Distilled from the user's working projects (kaparot-nof-hagalil — verified in production, judaica-stam, chabad-judaica, matchmaker-jewish-love, judaica-afula, mekoravim). Where something was verified live it says so; anything else is marked *unverified*.

## Basics

- **Base URL:** `https://www.call2all.co.il/ym/api/<WebServiceName>` (e.g. `.../SendSms`).
- **Auth:** a `token` parameter on every call. A single API key (`apik_...`, created in the Yemot system) is enough on its own — no system-number+password needed (verified, kaparot). The legacy form `<systemNumber>:<password>` also works as a token.
- **Server-side only.** Never ship the token to the browser (no `VITE_`/`NEXT_PUBLIC_` vars, no client-side `fetch` to call2all, no token stored in a DB table the client can read). judaica-afula does this from the browser — that's the anti-pattern; route through a server endpoint instead (see chabad-judaica `api/send-sms.js`).
- **Env var:** use `YEMOT_TOKEN` (+ optional `YEMOT_SMS_FROM`, `YEMOT_API_URL` for a mock in tests). Older projects used `CALL2ALL_TOKEN`, `YEMOT_SMS_API_KEY`, `YEMOT_TOKEN_BEIT_CHABAD` — same thing. The user sets secrets by hand in Railway → Variables; never write the value into code, git, or chat.
- **Request format:** both work in the user's projects:
  - `POST` with `Content-Type: application/json` body `{ token, phones, message }` — **verified in production** (kaparot). Prefer this.
  - `GET` with query string (`?token=...&phones=...&message=...`) — used by judaica-stam / chabad-judaica / matchmaker.
- **Response:** JSON with `responseStatus`: `"OK"` on success, otherwise (`"EXCEPTION"`, `"ERROR"`) with a `message`. Always read `res.text()` then `JSON.parse` in a try — on errors the body is not always JSON.
- **Timeouts:** always `AbortSignal.timeout(15_000)` (30s for bulk). A hung Yemot server otherwise piles up requests.

## SendSms

| param | notes |
|---|---|
| `token` | API key |
| `phones` | one phone, or many separated by **`:`** (colon). **Not comma** — a comma-joined list is treated as one invalid number → `"all Phone not is valid"` (verified bug in kaparot). |
| `message` | text; Hebrew + emoji OK. Long messages are split into multiple SMS units (cost). |
| `from` | *optional* sender ID (name or number) that is approved in the Yemot account, e.g. `חבד עפולה`. Omit if not approved. |

Success response: `{ responseStatus: "OK", sendCount, oks: [...], errors: { "<phone>": "<reason>" } }`.
**`responseStatus` can be `"OK"` while some recipients failed** — always check `errors`.

Phone format: local Israeli `05XXXXXXXX` (normalize `+972…`/`972…`/dashes → `0…`). This is what the verified code sends. matchmaker sends `+972…` and also works; local format is the safe default.

```js
const API = process.env.YEMOT_API_URL || 'https://www.call2all.co.il/ym/api';

export function normalizePhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('00972')) d = '0' + d.slice(5);
  else if (d.startsWith('972')) d = '0' + d.slice(3);
  return /^0\d{8,9}$/.test(d) ? d : null;
}

async function callYemot(service, params, timeoutMs = 15_000) {
  const token = process.env.YEMOT_TOKEN;
  if (!token) throw new Error('YEMOT_TOKEN לא מוגדר');
  let res;
  try {
    res = await fetch(`${API}/${service}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { throw new Error('בעיית תקשורת עם ימות המשיח'); }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || data.responseStatus !== 'OK') {
    throw Object.assign(new Error(data.message || `שגיאת ימות המשיח (${res.status})`), { details: data });
  }
  return data;
}

export async function sendSms(phones, message, from = process.env.YEMOT_SMS_FROM) {
  const list = [].concat(phones);
  const data = await callYemot('SendSms', { phones: list.join(':'), message, ...(from ? { from } : {}) }, list.length > 1 ? 30_000 : 15_000);
  const failed = Object.entries(data.errors || {}).map(([phone, error]) => ({ phone, error }));
  if (list.length === 1 && failed.length) throw new Error(failed[0].error);
  return { sent: data.sendCount ?? list.length - failed.length, failed };
}
```

## Reading SMS history

- `GetIncomingSms` — params `limit` (kaparot uses 1000), optional `startDate`, `endDate`. Returns `rows: [{ source, message, receive_date }]`.
- `GetSmsOutLog` — param `limit`. Returns `rows: [{ To, Message, Time, DeliveryReport }]`. For bulk sends `To` is the whole `a:b:c` string — split on `:` before matching a phone.
- No server-side filter by phone: fetch and filter locally, comparing **normalized** phones (Yemot may return `972…`, `05…` or `5…`).
- Incoming rows have **no stable id** → build one: `sha1(normalizedPhone|receive_date|message)`.
- To avoid refetching everything on each page view, store history in your DB and sync incrementally (judaica-stam `lib/smsStore.js`: `startDate` = last sync minus one day, dedupe by hash).
- Pattern: "reply 1 / 2" broadcasts — read incoming, keep only bodies exactly `1`/`2`, latest per phone (kaparot `getBroadcastResponses`).

## Other web services seen in the projects

`GetIVR2Dir?path=/` (list extension tree), `GetCustomerData`, `UploadTextFile` (upload a `.tts` file to an extension), `RunCampaign` with `withSMS=1` (SMS to regular mobiles, voice to kosher phones — *unverified, from the Yemot forum*). Generic call = `callYemot(name, params)`. kaparot has an admin "test console" (`src/lib/yemotIvr.js`) that runs `Service?param=value` lines server-side and **strips any `token` the user types** — reuse that pattern for debugging; never echo the token back.

## IVR extension (שלוחה) — `type=api` module

Yemot calls **your** URL on every step of the call, sending all values collected so far (GET or POST — read `{ ...req.query, ...req.body }`). Response must be **plain text** (`res.type('text/plain')`) — never JSON/HTML.

Incoming params: `ApiPhone` (caller ID — the only identity; normalize it), `ApiCallId`, `ApiDID`, `ApiExtension`, plus every variable you collected with `read=`. On hang-up Yemot calls again with `hangup=yes` → reply `ok`.

**Playback — `id_list_message=`** segments joined by `.`; each segment is `<type>-<value>`:
- `t-<text>` TTS of free text, `n-<number>` read a number, `s-<n>` TTS of a pre-uploaded `<n>.tts` file, `f-<file>` play an audio file.
- Free text must not contain `.` or `-` (they're separators) → replace with spaces.

**Input — `read=<prompt>=<capture>`** — the only action that continues the dialog; it **cannot be chained** with another action, so put any summary inside its prompt. Capture = 15 comma-separated fields in this order (verified against official examples; the written docs are off by one):
`name, reuse, max, min, timeout, format, blockStar, blockZero, keySub, allowedKeys, repeatCount, emptyAction, emptyPlaceholder, keyboardLock, skipConfirm`
- digits menu: `['Choice', '', 1, 1, 10, 'NO', '', '', '', '12', '', '', '', '', 'no']`
- number + `#`: `['Amount', '', 5, 1, 15, 'Number', '', 'yes', '', '', '', '', '', '', 'no']`
- speech-to-text (Hebrew): `['CustomerName', '', 'voice', 'he-IL', 'no', '', 'record', 3, 8]`

Because Yemot resends **all** collected vars each step, use **unique names per loop iteration** (`SlotChoice1`, `SlotChoice2`, …) or later answers overwrite earlier ones. Drive the flow as a state machine: "if param X missing → ask for X".

```js
const clean = (t) => String(t ?? '').replace(/[.\-]/g, ' ').replace(/\s+/g, ' ').trim();
export const say = (...texts) => `id_list_message=${texts.map((t) => `t-${clean(t)}`).join('.')}`;
export const read = (texts, capture) =>
  `read=${texts.map((t) => `t-${clean(t)}`).join('.')}=${capture.map((f) => f ?? '').join(',')}`;

router.all('/ivr/status', async (req, res) => {
  const p = { ...req.query, ...req.body };
  res.type('text/plain');
  if (p.hangup === 'yes') return res.send('ok');
  try {
    if (!p.Choice) return res.send(read(['לשמיעת המצב הקישו 1'], ['Choice', '', 1, 1, 10, 'NO', '', '', '', '1', '', '', '', '', 'no']));
    res.send(say('שלום', 'ההזמנה שלכם התקבלה'));
  } catch (e) {
    console.error('[ivr]', e);
    res.send(say('אירעה שגיאה זמנית, נסו שוב מאוחר יותר'));
  }
});
```

**Payment in the call (Nedarim Plus)** — append to a message: `id_list_message=t-מעבירים לתשלום&credit_card=nedarim_plus,<amount>,,1,1`. Yemot then calls back with `CreditCard_CODE`; success is **exactly** `CreditCard_CODE === 'OK'` (verified with a real test charge). Anything else = not paid, don't create the order. If creation fails after a successful charge, log it somewhere the admin sees (not only server logs).

**Security:** the endpoint is public. For anything that writes data or money, add a shared secret in the extension settings (`api_add_0=ivr_secret=<value>`) and reject requests without it. Read-only status lookups by `ApiPhone` may stay open.

**Troubleshooting:** if calls fail immediately with "שגיאה", isolate with a minimal endpoint returning `id_list_message=n-5` (no TTS), then `s-1` (pre-uploaded TTS file), then `t-…` — kaparot used this to pin a live `t-` TTS outage on Yemot's side.

## Good practices from the projects

- **Shabbat / Yom Tov:** don't send non-urgent SMS then; queue with `scheduled_for = nextSendableSlot()` and flush with a cron (matchmaker `sms_pending`, uses hebcal). OTP is never deferred.
- **Log every send** (`sms_log`: to, body, event, status, error) and redact OTP bodies.
- **Rate-limit** user-triggered sends (OTP: ≤3 per phone per 10 min, ≤5 attempts per code).
- **Quota per user** when users trigger sends (matchmaker `sms_quota/sms_used`, low-balance warning SMS).
- **Scheduled jobs** (e.g. weekly digest): claim atomically in the DB (`UPDATE … SET last_sent=today WHERE last_sent < today RETURNING *`) so multiple instances/restarts never double-send; store `last_error` for the UI.
- **Tests:** point `YEMOT_API_URL` at a local mock that returns `{"responseStatus":"OK","sendCount":1}` (and an `EXCEPTION` case) — never hit the real API in tests.

See `references/projects.md` for where each pattern lives.
