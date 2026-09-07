# Folder Podcast RSS Generator

Turns a nested folder of MP3s into iTunes-compatible podcast RSS feeds. Each
show directory gets a feed with stable episode GUIDs, durations, and cover art,
and a watcher regenerates XML when files change. Public share URLs make the
feeds and audio reachable by any player, including
[RadioWebApp](https://github.com/ozturkkl/RadioWebApp).

## Features

- **One feed per folder** - each subdirectory under the library root becomes a
  podcast channel with its own `rss/feed.xml`
- **iTunes and Podcast Index** - `itunes:` category, image, duration, and
  explicit tags, plus a persistent `podcast:guid`
- **Stable episode identity** - GUIDs and cached MP3 durations live in
  `rss/metadata.json`, so a rebuild does not look like a new show
- **Cover art** - the first `.jpg` or `.png` in a show folder is renamed to
  `cover.*` and used as the channel and episode artwork
- **Dates from filenames** - titles like `2024.03.12 Friday talk.mp3` or
  `12-03-2024 Friday talk.mp3` become publish dates; otherwise dates are
  synthesized so order stays stable
- **Prefix ranking** - folder-name prefixes in `prefixPriority` are stripped
  from the title, added as iTunes categories, and used to order `feed_urls.txt`
- **Watch and interval** - Chokidar regenerates on file changes, with a 4-hour
  safety pass; writes skip `lastBuildDate`-only diffs so a share sync does not
  loop
- **Player index** - a line-delimited `feed_urls.txt` at the library root is
  the list RadioWebApp fetches as `feedUrlsEndpoint`

## Stack

TypeScript · Node · ts-node · rss · chokidar · get-mp3-duration · uuid ·
fs-extra · dotenv

## How it is put together

```
  library folder (one subdirectory per show)
        │  MP3s, cover image, optional details.json
        ▼
  npm start / watch
        │
        ├─ <show>/rss/feed.xml
        ├─ <show>/rss/metadata.json   (GUIDs, durations, titles)
        └─ feed_urls.txt              (one feed URL per line)
                │
                ▼
        public share (ROOT_SHARE_URL)
                │
                ├─ any podcast client
                └─ RadioWebApp  ←  feedUrlsEndpoint
```

The generator never hosts files. It writes XML next to the audio, then prefixes
every enclosure, image, and feed URL with `ROOT_SHARE_URL` so a Nextcloud
public share, S3 bucket, or static HTTP folder can serve them as-is.

Expected library layout:

```
MAIN_DIRECTORY/
  metadata.json                 # created on first run if missing
  feed_urls.txt                 # generated index of feed URLs
  Featured-Friday Talks/
    cover.png                   # any jpg/png is renamed to cover.*
    details.json                # optional description / hideDate
    items/
      2024.03.12 Opening.mp3
      2024.03.19 Second talk.mp3
    rss/
      feed.xml
      metadata.json
```

## Getting started

Node 18+. Copy `example.env` to `.env`:

| Variable | Used for |
| --- | --- |
| `MAIN_DIRECTORY` | Library root with one folder per show |
| `ROOT_SHARE_URL` | Public base URL for that same tree |

```bash
npm install
cp example.env .env    # then edit paths
npm start              # generate once
```

Put MP3s in `<show>/items/`. Drop a cover image in the show folder. Run
`npm start` again, or leave `npm run watch` running while you add files.

## Scripts

| Command | What |
| --- | --- |
| `npm start` | Generate feeds for every show folder |
| `npm run watch` | Generate, then watch the library and rerun every 4 hours |
| `npm run refresh` | Delete existing `rss/` files, then generate from scratch |

`--refresh` wipes `rss/metadata.json`, so episode GUIDs are minted again.
Podcast apps will treat those as new episodes. Use it when you want a clean
slate, not for routine updates.

## Configuration

Root `metadata.json` is created with defaults you can edit:

| Field | Role |
| --- | --- |
| `websiteUrl` | Channel `site_url` |
| `categories` | Default iTunes categories |
| `coverUrl` | Fallback artwork when a show has no image |
| `prefixPriority` | Folder-name prefixes used for ranking and extra categories |

A folder named `Featured-Friday Talks` with `prefixPriority: ["Featured"]`
publishes as **Friday Talks**, gets an extra Featured category, and sorts
above unprefixed shows in `feed_urls.txt`.

Optional per-show `details.json`:

```json
{
  "description": "Weekly talks from the archive.",
  "hideDate": false
}
```

Feeds currently use language `tr` and episode copy `Bölüm: N`. Channel
descriptions fall back to the show title when `details.json` is absent.

## With RadioWebApp

Point RadioWebApp `podcast.feedUrlsEndpoint` at the public URL of
`feed_urls.txt`. The player loads that list, then fetches each `feed.xml`.
That is the path used in production live today.
