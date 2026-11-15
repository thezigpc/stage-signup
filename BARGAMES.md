# Bar Games integration report: Stage Signup 0.1.0

**Level 3**, SDK **0.15.0**, GameKit **0.8.0** (both vendored in `vendor/`). Manifest id
`signup`, port 3011, `routing.basePath: true`, image `ghcr.io/thezigpc/stage-signup:0.1.0`.

It's a module with rooms (`kind` "game", the default): one room per night or event. It only
keeps the signup queue and never plays media.

## `npx bargames check`

Against the mock box (`mock-box . --base /signup --port 7321 --core-port 7322 --game http://127.0.0.1:3011`):

```
✓ health /health → 200
✓ /__bargames/venue.json returns the box's branding ("Stage Signup (mock)")
✓ /__bargames/theme.css served
✓ "room_closed" declared (the box takes a closed room off the TVs at once)
✓ status refuses requests without the game token
✓ status → 0 room(s)
✓ unknown commands are rejected
✓ command "next_round" is wired (and refuses a missing room)
✓ command "end" is wired (and refuses a missing room)
✓ command "host_link" is wired (and refuses a missing room)
✓ command "cohost_link" is wired (and refuses a missing room)
✓ command "remove_cohost" is wired (and refuses a missing room)
✓ create_room → room NEQC (with hostUrl)
✓ status lists NEQC as a venue room
✓ table view /join/NEQC?as=table → 200
✓ host_link answers a new host link each time (take-over)
✓ cohost_link answers single-use invites that expire
✓ end closes NEQC
✓ NEQC left status after "end"

all checks passed
```

`npx bargames validate .`: ✓ (only the expected "not pinned by digest" warning).

## Events

All the events carry `sessionKind`. Data is names that people typed, song and artist only;
the open-mic note never leaves the room.

| Event | Where | `data` |
|---|---|---|
| `room_created`, `room_closed`, `players_changed` | the kit's `wireBarGames` from the registry | kit's shapes (`players` = patron phones) |
| `x-signup-added` | `Room.enqueue` (`server/src/rooms/Room.ts`) | `{ name, waiting, byHost }` |
| `round_started` | `Room.bringUp` | `{ round, name }` (round = performer number tonight) |
| `x-signup-next` | `Room.bringUp` | `{ round, name, song?, artist?, with?, mode, waiting }` |
| `round_ended` | `Room.leaveStage` | `{ round, name, result: "done" \| "skipped" \| "moved" }` |

Scenes and lights can follow `x-signup-next` (a performer is up) and `round_ended`.

## Commands

| Command | Room method | Refuses |
|---|---|---|
| `create_room` | `createVenueRoom` (registry): a venue room with an empty host seat ("Venue") and `HostSeats({ firstJoinerHosts })`; `hostUrl` = `/join/<code>?host=<key>` | the room cap |
| `next_round` | `Room.nextPerformer()`, the host's "Next performer": the current performer is done and the first in line goes up | unknown room; nobody on stage and nobody waiting |
| `end` | kit: closes like the host's close (cause `host`, "The host closed tonight's list.") | unknown room |
| `host_link` / `cohost_link` / `remove_cohost` | kit `HostSeats`, then `Room.takeOver` / `Room.demoteCohost` and a broadcast | unknown room; not a co-host |

There's no `start`, `pause` or `resume`: a list has no lobby or automatic progress. Pausing
*signups* is a host button; see the SDK requests.

**Status:** the kit's `overviews()`.
- `phase`: `"open"` or `"paused"` (signups).
- `round`: performers so far.
- `players`: patron phones.
- `title`: "<title> · Now: <name> · N waiting".
- `joinPath`: `/join/<code>`.

## Table route

`/join/{code}?as=table`
- [x] The URL alone joins as the TV: no name prompt and no gesture.
- [x] No audio.
- [x] Fills the screen with no scrolling, text 3vh or more, and 4–5% margins. Checked in a
  browser with nothing off-screen at 1920×1080, 1366×768, 1280×720, 3840×2160 and portrait
  1080×1920.
- [x] Recovers on its own: the kit's `useRoomConnection` resumes on every reconnect, and
  `tableMode` shows its banner on a box.
- [x] Static: no animation, and it only redraws when the list changes.
- [x] Nothing assumes a pointer: the TV has no buttons.

It shows:
- now performing;
- the next N people (the host picks 3–5);
- the QR code and `JoinAddress` (the box's short room link when there is one);
- the code;
- the host's message and "Signups paused";
- the venue's logo;
- the announcement strip (it subtracts `--bargames-announcement-top/bottom`).

## Container

- `node:22-slim`, `USER node`, and it only writes to `DATA_DIR` (`/data`: `admin.json`,
  `settings.json`).
- The queue lives in memory.
- **Not built locally:** Docker isn't installed on the dev PC. The first build is the GitHub
  workflow's.

## Standalone

- No `BG_*` env: `venue.json` says standalone, the command and status endpoints refuse, the
  name is `GAME_NAME` or "Stage Signup", and a spoofed staff header is ignored. Tested in
  `test/specs/05-bargames.test.mjs`.
- The same browser flow passes at the root standalone and under `/signup` on the mock box.
- Its own admin password: `ADMIN_PASSWORD` or first-run setup. On a box the venue's password
  works too (kit 0.5.1 `onBox`).

## Tests

`npm test`: 33 tests in 5 files.
- the queue;
- the limits;
- co-hosts;
- admin;
- the box: commands (good room, unknown room, wrong state), events, `create_room`,
  first-joiner hosting, take-over, co-host links, and the venue password.

## SDK requests

1. **Standard commands for pausing signups / intake.** `pause`/`resume` mean "automatic
   progress" today. A signup list (and maybe a trivia or tournament sign-up) would like the
   iPad to pause and open *joining*. Either say that `pause`/`resume` may mean "pause intake"
   for queue-type modules, or add `pause_signups`/`resume_signups`.
2. **A standard "message to the room" command** (`room_message { text }`), so staff can put
   "10 minute break" on a room's TV and phones from the box. Every module would draw it its
   own way.
3. **An event for "the queue changed"** with no per-person data, if Home Assistant wants a
   "N waiting" sensor. For now `x-signup-added` carries `waiting`, and `x-signup-next` does too.
