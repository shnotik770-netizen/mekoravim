# Where each pattern lives (shnotik770-netizen repos)

| Project | Files | What it shows |
|---|---|---|
| kaparot-nof-hagalil | `src/lib/sms.js` | SendSms (POST JSON, verified), bulk with `:` separator, `oks`/`errors`, GetIncomingSms/GetSmsOutLog, per-phone history, stable hash key, 1/2 broadcast replies |
| kaparot-nof-hagalil | `src/routes/ivr.js`, `src/lib/ivrFormat.js` | type=api IVR: `id_list_message`, `read=` 15-field capture, voice input, multi-item loop, Nedarim Plus `credit_card`, `ivr_secret`, `hangup=yes`, diag endpoints |
| kaparot-nof-hagalil | `src/lib/yemotIvr.js` | generic web-service test console that strips `token` |
| judaica-stam | `lib/call2all.js`, `lib/smsStore.js` | GET-style SendSms/GetIncomingSms/GetSmsOutLog, incremental history sync into Postgres |
| chabad-judaica | `api/send-sms.js` | minimal Vercel serverless proxy (token stays server-side; demo mode when unset) |
| matchmaker-jewish-love | `src/lib/sms.server.ts` | logging, quotas, Shabbat deferral queue, SMS OTP login with rate limits |
| judaica-afula | `src/lib/sms.ts` | `from` sender ID + message templates with `[var]` placeholders — **but sends from the browser (token exposed); don't copy that part** |
| mekoravim | `lib/sms.js` | weekly Sunday digest with atomic DB claim, mock-server testing via `YEMOT_API_URL` |
