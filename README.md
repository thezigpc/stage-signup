# Stage Signup

A signup queue for karaoke and open mic nights. Patrons put themselves on the list from their
phones; the TV shows who's on now and who's next; the host reorders, skips, marks people done
and pauses signups.

It doesn't play music or videos. The venue keeps using whatever it already uses (the YouTube
app, CDG files, a band).

Runs on its own as a plain web app, or as a module on a Bar Games venue box (see
[BARGAMES.md](BARGAMES.md)).

## What it does

- **Patrons** scan the QR code (or type the 4-letter code) and sign up:
  - a name or stage name;
  - karaoke: the song and artist; open mic: a free note that only the host sees;
  - optionally "with a friend" (a duet or group).

  They see their place in line and an estimated wait, and can drop out.
- **The host:**
  - drags the list to reorder it (or uses the arrow keys on the handle);
  - has "Next performer", "Now on", "Done", "Skip", "Move to end" and "Put back";
  - can pause signups and post a message to the queue ("10 minute break");
  - can add someone by hand (no phone needed), or edit an entry;
  - sets the limits: one signup per phone at a time, and the most signups per phone per night.

  Co-hosts can run the list too (a single-use invite QR), but they can't close it.
- **The TV** (`/join/<CODE>?as=table`) shows:
  - who's performing now and the next 3–5 people;
  - the join QR code and address;
  - the host's message, and the venue's theme and announcements when it runs on a box.
- **Admin** (`/admin`): the open lists and the auto-close time. The password comes from
  `ADMIN_PASSWORD`, or is set once on first visit.

## Run it

```bash
npm install
npm run build
npm start -w server        # http://localhost:3011
```

Development: `npm run dev` (Vite on :5181, server on :3011). Tests: `npm test` (after a build).

Docker: `docker compose up -d --build` (publishes to `127.0.0.1:3011`; put your own proxy or
tunnel in front). The bind-mounted `./data` must be owned by uid 1000.

| Env | Default | |
|---|---|---|
| `PORT` | 3011 | |
| `DATA_DIR` | `./data` | admin password hash and settings |
| `GAME_NAME` | Stage Signup | the name on every page |
| `ADMIN_PASSWORD` | (unset) | overrides the one set on `/admin` |
| `BASE_PATH` | (unset) | serve under a path behind your proxy, e.g. `/signup` |
| `ROOM_IDLE_MINUTES` | 360 | default auto-close time (admin can change it) |
| `SIGNUPS_PER_MINUTE_PER_IP` | 60 | flood guard; behind Cloudflare a whole bar shares one IP |

Lists live in memory: a restart clears tonight's queue.
