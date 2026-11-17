# Stage Signup

A signup list for karaoke and open mic, nothing more.
- Patrons sign up from their phones.
- The TV shows now and next.
- Staff or a guest host run the list.

**It never plays music or video. Keep it that way** (the user's brief).

It's a Bar Games **app** since 0.2.0 (the user's decision, relayed by the GameBroker session on
2026-11-16): id `signup`, port 3011, SDK level 2, with guest hosts. It also runs standalone. The
platform is `C:\CodeProjects\GameBroker` (public repo thezigpc/venueplay).
- **Don't edit** GameBroker, GameKit or other modules.
- Send platform needs to the "GameBroker Session" as SDK requests (BARGAMES.md, "Platform gaps").

## Model

- **No rooms.** The venue has **stages**, set up by staff on `/admin` (`stages.json`). Each
  stage has its own list, saved to `tonight.json` so updates keep the queue, and its own TV
  (`/tv?stage=<id>`). "New night" clears a stage's list.
- **Patrons are a device id** (localStorage `signup_device`), sent with the socket's `watch`.
  No seats or tokens. Per-phone limits key on it.
- **Kiosk (0.2.1):** a screen with GameKit's on-screen keyboard (`useOnScreenKeyboard()`, a box
  touchscreen or `?bg_keyboard=1`) is shared. `StageSignup` uses an unsaved `newDeviceId()` per
  patron, and `PatronView` shows `KioskDone` (no Drop out) and then resets. `<OnScreenKeyboard />`
  is mounted once in `main.tsx`. Every text field needs `maxLength` and a `<form onSubmit>`
  whose handler checks its own fields.
- **Running the list is HTTP only:** `/api/run/<stage>/<action>`, behind the kit's
  `staffOrGuest`.
  - Staff: the app's admin session (bearer token from `/admin`, same tab), or `bg.isStaff`.
  - A guest host or co-host: `bg.guest(req)`, checked on **every** request.
  - The stages setup (`/api/admin/*`) stays staff only.
- **The runner's private view** (notes, history) reaches a socket only while it holds a lease
  (`/api/run/lease`, 150 s, which the page renews every 60 s). Off a box, guests never exist.

## Layout

The same shape as BingoDigitalGame (an npm-workspaces monorepo):
- `shared/src/protocol.ts`: `StageView`, `StageConfig`, `StageLive`, `LIMITS`, `ERRORS`,
  `cleanText`, `slugify`, `estimatedWait`.
- `server/src/stages/Stage.ts`: one stage's list. `bringUp` and `leaveStage` are the only
  places that change who's on stage, and they raise the events. It has `toState`/`loadState`
  for saving.
- `server/src/stages/registry.ts`: the stages, their setup, and saving.
- `server/src/run/routes.ts`: the run controls and a guest host's co-hosts.
- `server/src/admin/routes.ts`: the kit's admin auth plus the stages CRUD.
- `server/src/socket/index.ts`: `watch`, `signUp`, `dropOut`, the per-stage broadcast and the
  lease.
- `server/src/bargames.ts`: the only SDK connection (`bg`, `guestOf`, the events).
- `client/`:
  - routes `/` (`PatronPage`), `/tv` (`TvPage`), `/kj` (`KjPage` → `HostView`) and `/admin`
    (`AdminPage` → `StagesAdmin`);
  - `useStage` re-sends `watch` on every connect;
  - **drag to reorder** uses pointer events on a ⠿ handle (`touch-action: none`), and the
    arrow keys work too.
- `test/`: `npm test` runs node:test specs, and each file spawns its own server.
  - Build first.
  - `ADMIN_PASSWORD` is "pw" in tests.
  - The box tests fake the gateway's guest headers.

## Rules carried over from Bingo

- **Standalone:** box-only behavior goes behind `bg.connected` or `isOnBox(ctx)`.
- **Paths:** never write a bare `"/api/…"`. Use `serverUrl`, `basePath()` or `joinUrl()`, so
  the app works under `/signup`.
- **Storage:** every storage key starts with `signup_`.
- **SDK upgrades:** a new SDK or kit arrives under a new tarball name. Update both
  `package.json` files.
- **Releases:** bump `version` and the image tag in `bargames.json` together, and never
  re-publish a tag.

## Testing on this PC

Other sessions run mock boxes too.
- Check ports with `Get-NetTCPConnection -LocalPort <p>` first.
- Run the mock box from PowerShell (Git Bash mangles `/signup`):
  `npx bargames mock-box . --base /signup --port 7321 --core-port 7322 --game http://127.0.0.1:3011`.
- `/__bargames/guest?name=Dana` (add `&as=cohost` for a co-host) makes you a pretend guest.
- Stop only the PIDs on your own ports, never by name.

Docker isn't installed here.
