# Stage Signup

A signup queue for karaoke and open mic, nothing more: patrons sign up from their phones, the
TV shows now and next, and the host runs the list. **It never plays music or video. Keep it
that way** (the user's brief).

It's a Bar Games module (id `signup`, port 3011, SDK level 3) that also runs standalone. The
platform is `C:\CodeProjects\GameBroker` (public repo thezigpc/venueplay).
- **Don't edit** GameBroker, GameKit or other modules.
- Send platform needs to the "GameBroker Session" as SDK requests (see BARGAMES.md).

## Layout

The same shape as BingoDigitalGame (an npm-workspaces monorepo):
- `shared/src/protocol.ts`:
  - the socket events, `RoomView`, `RoomSettings`, `LIMITS` and `ERRORS`;
  - `cleanText`;
  - `estimatedWait` (minutes per turn, minus how long the current performer has been up).
- `server/src/rooms/Room.ts`: the queue state machine.
  - **Entries** are `waiting | up | done | skipped | dropped`. `queue` holds the waiting ids in
    order; `nowId` is the one on stage. `bringUp` and `leaveStage` are the only places that
    change who's on stage, and they emit `round_started`, `x-signup-next` and `round_ended`.
  - **Roles:** `host`, `cohost`, `patron` and `table`. The kit's `HostSeats` decides who may
    host.
  - **Patrons** have a `device` id (per-device localStorage `signup_device`), so a new tab or
    a rescanned QR code gets the same seat. The per-phone limits key on the member.
- `server/src/socket/index.ts`: intents. Each runs a Room method and then broadcasts.
  - **Join attempts:** failed ones are rate-limited per IP.
  - **Signups:** limited per IP (`SIGNUPS_PER_MINUTE_PER_IP`, default 60, because behind
    Cloudflare a whole bar shares one IP).
  - **Leaving:** a patron leaving keeps their place in line; dropping out is separate.
- `server/src/bargames.ts`: the only SDK connection (`wireBarGames`: `create_room`,
  `next_round`, `end` and the hosting commands).
- `client/`:
  - React with routes `/`, `/join/:code` and `/room/:code`.
  - `/join/:code` auto-joins: as a patron by default, as the TV with `?as=table`, and as the
    host with `?host=<key>`. With `?cohost=` it asks for a name first.
  - `RoomPage` picks `HostView`, `PatronView` or `TableView`.
  - **Drag to reorder** in `HostView` uses pointer events on a ⠿ handle (`touch-action: none`;
    HTML5 drag-and-drop doesn't work on iOS). The arrow keys work on the handle too.
- `test/`: `npm test` runs node:test specs, and each file spawns its own server. Build first.

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
- Stop only the PIDs on your own ports, never by name.

Docker isn't installed here.
