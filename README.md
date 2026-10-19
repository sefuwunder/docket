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
```

Dates are local `YYYY-MM-DD`, datetimes local `YYYY-MM-DDTHH:MM` — no timezones in v1.

## Project layout

```
src/agent.js    shared ESM: NL parser, free-time finder, conflict logic
                (imported by bun tests, the server, and the browser)
src/server.ts   Bun server: SQLite storage + REST API + agent endpoint
public/         index.html, styles.css, app.js (UI)
tests/          bun test suites
```

## Future work

- Google Calendar sync (local-first for now)
- Notifications / reminders
- Sharing / collaboration
