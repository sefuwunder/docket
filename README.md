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

Relative dates (`today`, `tomorrow`, `day after tomorrow`, `this Friday` vs `next Friday`, bare weekday names), times (`noon`, `midnight`, `2pm`, `14:30`), durations (`for 45 min`, `for 2 hours`; default 1h), and parts of day (`morning`, `afternoon`, `evening`, clipped to working hours 9:00–18:00) are all understood.

- **Conflict handling:** creating over an existing event reports the conflict and proposes the nearest free alternatives as tappable chips; tapping one asks what to call it, then books it.
- **Confirm-before-destructive:** moves and deletes always require a tap-to-confirm chip first. Ambiguous matches ("move lunch…") ask which event you mean.

## API sketch

```
GET    /api/events?from=YYYY-MM-DD&to=YYYY-MM-DD   list (recurrences expanded)
POST   /api/events[?force=1]                        create (409 + conflicts unless force)
PUT    /api/events/:id                              update
DELETE /api/events/:id                              delete
POST   /api/agent  {message} | {confirmId} | {pickmove}
GET    /api/settings                                 masked status: ical configured?, GOA accounts (identities redacted)
POST   /api/settings  {icalUrl} | {goaEnabled}       store iCal secret URL (server-side only) / toggle GOA
```

Dates are local `YYYY-MM-DD`, datetimes local `YYYY-MM-DDTHH:MM` — no timezones in v1.

## Project layout

```
src/agent.js    shared ESM: NL parser, free-time finder, conflict logic
                (imported by bun tests, the server, and the browser)
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
