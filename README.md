# Docket

A mobile-first, iOS-style calendar with an in-app scheduling agent. No accounts, no cloud, no AI keys — everything runs locally and deterministically.

## Run it

```sh
bun src/server.ts
```

Then open **http://127.0.0.1:3037**. (Bun is the only dependency; there are zero npm packages. SQLite via `bun:sqlite`. `PORT` / `HOST` env vars override the bind.)

## Features

- **Calendar tab** — Month grid with event dots, Day timeline (00–24 with a "now" line), and Agenda list grouped by day. Segmented control switches views; tapping a month day jumps to that day.
- **Event sheets** — iOS-style swipe-up sheet to create/edit events: title, start/end (native pickers), location, notes, color tag, repeat (daily / weekdays / weekly). Destructive delete asks for a tap-to-confirm.
- **Swipe-to-delete** on agenda rows (swipe left, tap Delete, tap Confirm).
- **Scheduling agent tab** — a Messages-like chat with a deterministic local natural-language parser. No LLM, no API keys.
- **External calendars (Settings ⚙)** — an iCal secret URL field (password input, stored server-side in SQLite, never returned to the client) and read-only discovery of GNOME Online Accounts with calendar enabled. Google accounts sync via the Calendar API using GOA's OAuth token (fetched on demand, never stored). External events appear as **read-only busy blocks** in all three calendar views (hollow dots in month view, hatched blocks in day view, source-tagged rows in agenda — tapping one opens a read-only info sheet, never the edit sheet) as well as in the agent's free-time finder, conflict detection, and "what's on" — "busy 2–3pm per your google calendar". They can never be edited or deleted from Docket (PUT/DELETE/POST against an `ext:` id are rejected). A **Sync now** button in Settings runs the collectors over ±45 days and reports the *real* per-account status (synced + event count, needs re-auth, unsupported provider, or an honest "unreachable" note) — statuses are never hardcoded. 5-minute TTL cache, invalidated on sync and on settings changes; a downed source falls back to local-only with a quiet note.

## Agent language reference

| Say | Does |
|---|---|
| `lunch with Ana tomorrow at noon` | creates a 1h event tomorrow 12:00–13:00 |
| `dentist Friday 2pm` | creates Friday 14:00–15:00 |
| `standup every weekday 9am` | creates a weekdays-recurring event |
| `meeting Oct 23 at 14:30 for 45 min` | explicit date, time, duration |
| `move dentist to Thursday` | asks for tap-to-confirm, then moves it |
| `cancel lunch with Ana` | asks for tap-to-confirm, then deletes |
| `what's on Tuesday?` | lists that day's events |
| `find 30 min free tomorrow afternoon` | proposes free slots as tappable chips |
| `when am I free Friday?` | same, default 30 min |
| `train the model` | trains the category model on your last 30 days of tagged events |
| `what patterns do you see` | summarizes your tagging patterns (top words per color, habitual slots) |
| `categorize my week` | same as above |

Relative dates (`today`, `tomorrow`, `day after tomorrow`, `this Friday` vs `next Friday`, bare weekday names), times (`noon`, `midnight`, `2pm`, `14:30`), durations (`for 45 min`, `for 2 hours`; default 1h), and parts of day (`morning`, `afternoon`, `evening`, clipped to working hours 9:00–18:00) are all understood.

- **Conflict handling:** creating over an existing event reports the conflict and proposes the nearest free alternatives as tappable chips; tapping one asks what to call it, then books it.
- **Confirm-before-destructive:** moves and deletes always require a tap-to-confirm chip first. Ambiguous matches ("move lunch…") ask which event you mean.

## API sketch

```
GET    /api/events?from=YYYY-MM-DD&to=YYYY-MM-DD   list (recurrences expanded)
POST   /api/events[?force=1]                        create (409 + conflicts unless force)
PUT    /api/events/:id                              update
DELETE /api/events/:id                              delete
POST   /api/agent  {message} | {confirmId} | {pickmove} | {applytag}
POST   /api/model/train                           train the category model on the last 30 days
GET    /api/model/status                           trained? n, classes, accuracy, trainedAt
GET    /api/model/predict?title=&start=&end=       advisory tag suggestions (event sheet)
GET    /api/settings                                 masked status: ical configured?, GOA accounts (identities redacted)
POST   /api/settings  {icalUrl} | {goaEnabled}       store iCal secret URL (server-side only) / toggle GOA
```

Dates are local `YYYY-MM-DD`, datetimes local `YYYY-MM-DDTHH:MM` — no timezones in v1.

## Category model (local, deterministic)

**Judgment call:** the model's target is the event's **color tag** — the only labels in the system. It learns `P(color | title words + when)` so the agent can suggest a tag for new events and report learned patterns. If you later want a different target (e.g. duration prediction), the feature/label plumbing in `src/model.js` is generic — swap the label and retrain.

- **What it is:** multinomial logistic regression (softmax), full-batch gradient descent + L2, seeded init, fixed epochs — same data always yields identical weights. Pure JS, no AI services, everything stays on your machine.
- **Features:** title unigrams + bigrams (vocab from your data), day-of-week one-hot, start-hour bucket (night/morning/midday/afternoon/evening/late), duration bucket (<30m / 30–60m / 1–2h / >2h).
- **Training labels:** only events whose color you *explicitly* chose count (`color_set=1`: the event sheet, or a confirmed tag suggestion). Untouched defaults and external read-only events never train the model. Fewer than 10 labeled events → the trainer refuses honestly instead of building a junk model.
- **How to train:** tell the agent `train the model`, or `POST /api/model/train`. It reports train accuracy and 5-fold cross-validated accuracy (with a "small sample" note under 25 events). `GET /api/model/status` shows what's stored.
- **How it's used:** when the agent creates an event, a confident prediction (clear favorite: top ≥ 50% and ≥ 1.5× the runner-up) appears as a tappable chip — `Tag green (59%)` — and is **never auto-applied**; you confirm. The event sheet shows the same advisory chip under the title while typing. `what patterns do you see` / `categorize my week` summarizes your last 30 days: per-color counts, the words most predictive of each color, and habitual slots ("your Friday evenings are usually orange").
- **Limitations:** 30 days of personal calendar is tens of events — expect modest accuracy and take the cross-validation number seriously. The model only knows what you've tagged; a new routine takes a few tagged examples to learn. Nothing leaves the machine.

## Project layout

```
src/agent.js    shared ESM: NL parser, free-time finder, conflict logic
                (imported by bun tests, the server, and the browser)
src/model.js    pure ESM: local discriminative category model — feature
                extraction + multinomial logistic regression (SGD + L2,
                seeded, deterministic) + pattern summary
src/ical.js     pure ESM: VCALENDAR parser + RRULE expansion → busy blocks
src/external.js server-side: GOA enumeration, Google Calendar API, iCal fetch,
                TTL cache — secrets never leave this module
src/server.ts   Bun server: SQLite storage + REST API + agent endpoint
public/         index.html, styles.css, app.js (UI)
tests/          bun test suites
```

## Future work

- Notifications / reminders
- Sharing / collaboration
