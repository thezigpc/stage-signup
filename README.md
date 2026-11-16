# Stage Signup

A signup list for karaoke and open mic nights.
- **Patrons** put themselves on the list from their phones.
- **The TV** shows who's on now and who's next.
- **Whoever runs the night** reorders the list, skips people, marks them done and pauses
  signups. That's the staff, or a guest host.

It doesn't play music or videos. The venue keeps using whatever it already uses (the YouTube
app, CDG files, a band).

It runs on its own as a plain web app, or as an **app** on a Bar Games venue box (see
[BARGAMES.md](BARGAMES.md)).

## Pages

| Page | Who | What |
|---|---|---|
| `/` | patrons | Sign up: a name or stage name, then the song and artist (karaoke) or a note only the host sees (open mic), and optionally "with a friend". They see their place in line and an estimated wait, and can drop out. There's no code to type. With one stage there's no picker; `/?stage=<id>` goes straight to a stage. |
| `/tv?stage=<id>` | the TV | Now performing, the next 3–5 people, the QR code and address, the number waiting, and the host's message. With no stage given, or one that's off, it shows the first stage that's on. |
| `/kj` | staff or a guest host | Run the list (details below). |
| `/admin` | staff only | The stages: name, on/off, order, karaoke or open mic, the per-phone limits, the minutes per turn, and how many names the TV shows. |

On `/kj` you can:
- drag the list to reorder it (or use the arrow keys on the handle);
- use "Next", "Now on", "Done", "Skip", "Move to end" and "Put back";
- add a walk-up and edit an entry;
- pause signups and post a message to the queue;
- start a "New night", which clears that stage's list.

**Who runs the list:** staff sign in on `/admin` with the app's password (`ADMIN_PASSWORD`, or
set once on first visit), then open `/kj`. On a Bar Games box, staff can also give a patron a
**guest link**:
- The guest host gets `/kj` only. They can't open `/admin`.
- They can add co-hosts, who get the same controls but can't add anyone.

Each patron is a device id kept in the phone's browser. Their place in line and the limits
follow that id, across tabs and a rescanned QR code.

Stages are kept in `DATA_DIR/stages.json`, and tonight's lists in `DATA_DIR/tonight.json`. Both
are saved within half a second of a change, so a restart or update keeps the queue.

## Run it

```bash
npm install
npm run build
npm start -w server        # http://localhost:3011
```

- **Development:** `npm run dev` (Vite on :5181, server on :3011).
- **Tests:** `npm test` (after a build).
- **Docker:** `docker compose up -d --build`. It publishes to `127.0.0.1:3011`, so put your own
  proxy or tunnel in front. The bind-mounted `./data` must be owned by uid 1000.

| Env | Default | |
|---|---|---|
| `PORT` | 3011 | |
| `DATA_DIR` | `./data` | admin password hash, stages, tonight's lists |
| `GAME_NAME` | Stage Signup | the name on every page |
| `ADMIN_PASSWORD` | (unset) | overrides the one set on `/admin` |
| `BASE_PATH` | (unset) | serve under a path behind your proxy, e.g. `/signup` |
| `SIGNUPS_PER_MINUTE_PER_IP` | 60 | flood guard; behind Cloudflare a whole bar shares one IP |
