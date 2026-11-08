# Fr. Bobby Vogel — meeting scheduler

Public booking site for meetings with Fr. Bobby at St. Mary (Rushville) and
St. Gabriel (Connersville). It reads his Google Calendar, offers open times at
the parish where he celebrates Mass that day, books meetings onto his calendar,
and emails everyone when a meeting is booked, moved or cancelled.

## What's in this repository

| Folder | What it is | Where it runs |
| --- | --- | --- |
| `site/` | The page people visit at your own web address. It shows the scheduler inside it. | Netlify (published automatically) |
| `apps-script/` | The scheduler itself: availability, booking, emails, admin page. | Google Apps Script (copied in by hand) |

`netlify.toml` tells Netlify to publish only `site/`, so the script files are
never visible on the website.

## Changing the website page

Edit `site/index.html` and commit to `main`. Netlify republishes the site on its own.

## Changing the scheduler

Apps Script doesn't read from GitHub, so after changing a file in `apps-script/`:

1. Open the project at script.google.com.
2. Paste the new contents into the matching file (`Code.gs`, `Index`, and
   `appsscript.json` under Project Settings → "Show appsscript.json").
3. Save, then Deploy → Manage deployments → pencil icon → Version: **New version** → Deploy.

The public link and admin link stay the same after a new version.

## Settings worth knowing

All in the `CONFIG` block at the top of `apps-script/Code.gs`:

- `PUBLIC_URL`: your own web address for the booking page, so emailed links use it.
- `HOURS`, `BUFFER_MINUTES`, `MIN_NOTICE_HOURS`, `DAYS_AHEAD`: when people can book.
- `TYPES`: meeting kinds, lengths and descriptions.
- `EXTRA_CLOSED_DATES`: extra days to close, such as `'2026-12-26': 'Christmas break'`.

The private admin key is stored in the script's Script Properties, not in this
code. Run `showLinks` in the editor to print the admin link, or `resetAdminLink`
to replace it.
