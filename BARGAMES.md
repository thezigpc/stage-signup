# Bar Games integration report: Stage Signup 0.2.1

- **An app** (`"kind": "app"`), **level 2**.
- **Versions:** SDK **0.16.0**, GameKit **0.10.0** (both vendored in `vendor/`).
- **Manifest:**
  - id `signup`, port 3011, `routing.basePath: true`;
  - image `ghcr.io/thezigpc/stage-signup:0.2.1`;
  - `guests: { path: "/kj", cohosts: true }`.

0.1.0 was a game with rooms. 0.2.0 has none: no room codes, `sessionKinds` or commands, and no
`HostSeats`. It never plays media.

## Routes

| Route | Page |
|---|---|
| `player` `/` | patron signup (a stage picker only when more than one stage is on; `?stage=<id>`) |
| `table` `/tv` | a stage's "Up next" screen (`?stage=<id>`; with none, or one that's off, the first stage that's on). The box can cast it, use it as an idle screen or start it from a scene. |
| `host` `/kj` | running the list: staff, or a guest host or co-host (also `guests.path`) |
| `admin` `/admin` | stages setup, staff only |

## Checks

`npx bargames validate .`: ✓ `signup@0.2.1 (sdk level 2)` (only the expected "not pinned by
digest" warning).

`npx bargames check` on the mock box (`--base /signup --port 7321 --core-port 7322`):

```
✓ health /health → 200
✓ /__bargames/venue.json returns the box's branding ("Stage Signup (mock)")
✓ /__bargames/theme.css served
✓ phone page (routes.player) / → 200
✓ TV view (routes.table) /tv → 200

all checks passed
```

## On-screen keyboard (0.2.1, GameKit 0.10.0)

- The kit's `<OnScreenKeyboard />` is mounted once, at the root, so it covers every page: the
  signup page, the TV, `/kj` and `/admin`. Phones, tablets and PCs never get it.
- Every text field is a real `<input>` or `<textarea>` with `maxLength`, inside a
  `<form onSubmit>`, so the keyboard's Enter submits. The submit handlers check the fields
  themselves, because Enter submits even when the button is disabled. There are no number
  fields: the stage limits are dropdowns.
- **The signup kiosk.** A screen that gets the keyboard is treated as a shared kiosk rather
  than someone's phone:
  - each patron gets a fresh, unsaved device id, so the per-phone limits don't block the next
    person;
  - the form doesn't fill in the last name typed;
  - after signing up, the patron sees their place without a "Drop out" button (the next
    person would get it). It shows "Next person" and goes back to an empty form after 20 s.
- **Nothing hides under the keyboard.**
  - The page mirrors the kit's body padding into `--keyboard-h`.
  - The toast (refusals such as "Signups are paused") sits above it.
  - So does the host's edit dialog, which now opens in a portal: a queue row's drag transform
    used to pin that `fixed` dialog to the row.
  - The venue's announcement strip, when it's at the bottom, is under the keyboard while
    someone types. That's the kit's own bar.

## Guest hosts (SDK 0.16.0)

- **The run controls** are HTTP, at `/api/run/*`, behind the kit's
  `staffOrGuest({ auth, guest: bg.guest, trusted: bg.isStaff })`, so every request is checked.
  They are next, done, now on, skip, to the end, put back, move, add a walk-up, edit, pause or
  open signups, the message, and New night.
- **Staff-only routes:** `adminRouter` (the stages: name, on/off, order, mode, limits) stays
  staff only. A guest's `/api/admin/*` gets 401, and `/admin` shows them the sign-in form.
- **The live view:** a socket that shows the host page only gets the private view (open-mic
  notes and history) while it holds a **lease**. The page renews the lease every 60 s through
  `/api/run/lease`, and the guest check runs there each time. When a guest link ends, the next
  action is refused and the private view stops within 150 s, even on an open socket. Patrons
  and TVs get the public view.
- **Co-hosts:**
  - The guest host's `/kj` shows "Add co-host" with a name field. `bg.guests.addCohost(req, name)`
    returns a `url`, which the page shows as a QR code.
  - When the venue hasn't turned co-hosts on, the box's error message is shown as-is.
  - The host lists their own co-hosts (`bg.guests.list()` filtered by `parentId`) and can remove
    them (`bg.guests.revoke`).
  - Co-hosts get the run controls but can't add anyone (403).
- **Off a box** guests never exist (`bg.guest` is ignored), and staff use the app's own admin
  password. The tests check that spoofed guest and staff headers get 401.

## Events (declared)

None of these events has a `roomCode`. Each carries the `stage` id. They contain only names
and songs that people typed: the open-mic note never leaves the app.

| Event | When | `data` |
|---|---|---|
| `x-signup-added` | a signup or walk-up joins a list | `{ stage, name, waiting, byHost }` |
| `x-signup-next` | a performer goes on stage | `{ stage, round, name, song?, artist?, with?, mode, waiting }` |
| `x-signup-ended` | a performer comes off | `{ stage, round, name, result: "done" \| "skipped" \| "moved" }` |
| `x-signup-waiting` | the waiting count changed (at most every 2 s per stage) | `{ stage, waiting }`, with no names |
| `x-signup-paused` | signups paused or opened | `{ stage, paused }` |
| `x-signup-new-night` | a stage's list was cleared | `{ stage }` |

- **On-screen keyboard (0.2.1), on the mock box with `?bg_keyboard=1`, at 1080p and 4K, by
  tapping the keys:**
  - On the kiosk, Ann types her name, song and artist, and Enter signs her up.
  - "Next person" gives an empty form, and Bo signs up as #2.
  - Enter with no song is held by the form.
  - The kiosk resets on its own after 20 s.
  - `maxLength` holds, and Done closes the keyboard.
  - The KJ adds a walk-up (name and song, then Enter), edits an entry in the dialog, posts a
    message and adds a co-host.
  - Staff sign in on `/admin` and add a stage.
  - Every field stays above the keyboard, and so does the toast.
  - `?bg_keyboard=0` turns it off.
  - On a phone there's no keyboard, the field isn't changed to `inputmode=none`, "Drop out" is
    still there, and there's no sideways scroll at 320 px.
  - The 0.2.0 walk-through above passes again, with no console errors.

## Data on the box

`/data` holds:
- `admin.json`, as before;
- `stages.json`, the stages' setup;
- `tonight.json`, tonight's lists, saved 0.5 s after a change and on SIGTERM.

An update or restart keeps the queue.

**Upgrading from 0.1.0:** its `settings.json` (room idle time) is ignored. With no
`stages.json`, the app starts with one stage, "Main stage". Its admin password carries over.
Old room links (`/join/ABCD`) land on the signup page.

## Tests

- **`npm test`:** 28 tests in 4 files: the list, limits and privacy (with lease expiry),
  stages (restart and the 0.1.0 data dir), and the box. The box tests use a fake core with
  guest-link endpoints: a guest host, a co-host, box staff, the co-host links (refused, made,
  listed, revoked), events, and the venue password.
- **Browser walk-through on the mock box** (all passing, no console errors):
  - three phones sign up with no picker;
  - the TV;
  - `/__bargames/guest?name=Dana` lands on `/kj` as a guest host, who drags to reorder,
    brings people up, pauses signups and posts a message (and a new phone sees "Signups are
    paused");
  - the guest host adds a walk-up;
  - the guest host adds co-host "Sam" (QR shown); Sam's link opens `/kj` as a co-host, who
    marks a performer done; the host removes Sam, and Sam's next action is refused;
  - the guest gets the sign-in form at `/admin`;
  - staff sign in with the box password and add "Patio" (open mic); a phone sees the picker
    and signs up; the Patio TV hides the note; the host page gets stage tabs; turning Patio off
    tells the phone, and the Patio TV falls back to Main stage;
  - New night clears the list.
- **Screen sizes:** the TV has no overflow at 1920×1080, 1280×720, 4K or portrait, and the
  phone pages have no sideways scroll at 320 px.
- **Standalone:** staff set the app password, run the list from `/kj`, and the TV follows.
  `/kj` with no session is refused.

## Container

- Image `node:22-slim`, running as `USER node`. It writes only to `DATA_DIR`.
- Not built locally (no Docker on this PC); the GitHub workflow builds it.

## Platform gaps

1. **Revoked guests on open sockets.** `bg.guest(req)` can be checked per HTTP request, but a
   WebSocket's handshake headers never change. I worked around it with a short lease renewed
   over HTTP. Either of these would let apps do without one:
   - the gateway closes a guest's WebSocket when their link ends;
   - or an SDK `bg.guests.valid(id)`.
2. **`GuestInfo` and the other guest types** are exported from `@bargames/sdk`, but not from
   `@bargames/sdk/server`, where `bg.guest` lives.
3. **`bargames check` for apps** doesn't exercise `guests`. It could open `guests.path` through
   `/__bargames/guest?name=…` and check it answers 200, and `addCohost` with and without the
   venue's switch.
4. **The SDK's `addCohost`** doesn't refuse a co-host caller itself (it relies on the box). The
   app checks `role === "host"` before calling it.
