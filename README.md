# Threadline

Threadline is a local Threads lead radar. It opens a real browser session, searches recent Threads posts for each phrase, scrolls to reveal more results, extracts the author, profile link, post link, and post text, then repeats on an adjustable schedule.

## Run it

```powershell
npm.cmd install
npx.cmd playwright install chromium
npm.cmd start
```

Open [http://localhost:4173](http://localhost:4173).

## First-time setup

1. Select **Connect Threads**.
2. Select **Open Threads login** and finish signing in inside the Chromium window.
3. Return to Threadline and select **I’m signed in — check connection**.
4. Enter a natural-language search such as `finding a web developer`.
5. Choose the interval and number of posts, then select **Start listening**.

The first sweep runs immediately. Later sweeps run while the Node process is active. Browser session data and collected results stay under `data/`, which is ignored by Git.

## What is implemented

- Persistent, local Threads login through Playwright
- Recent-search URLs built from the user's phrase
- Extraction from `[data-pagelet^="threads_search_results_"]`
- Repeated scrolling, result de-duplication, and normalized Threads links
- Single-file queue so browser runs do not overlap
- Independent intervals from 1 minute to 24 hours
- Run now, pause, resume, and remove controls
- New/saved/dismissed lead states and inbox filters
- Confirmed bulk deletion for clearing all collected leads without removing searches
- Buyer-intent scoring that separates direct requests from promotions, profiles, and incidental matches
- Manual General-to-Buyer qualification with immediate one-time Slack/Discord delivery
- Strict seller-ad vetoes, English/Indonesian request signals, short-post quality checks, and repost suppression
- Threads `abbr[aria-label]` timestamp capture with a strict 24-hour default lead window
- Per-search post-age windows: 24 hours, 3 days, 7 days, 14 days, or 30 days
- Optional United States post filter using `US`, `U.S.`, `USA`, `United States`, or a valid `+1` phone number
- Buyer-only Slack Block Kit and Discord embed delivery with URL validation
- Delivery tests and notification event preferences
- Persistent searches, leads, activity, webhook settings, and run statistics

## Environment options

Copy `.env.example` values into your shell or process manager if needed:

- `PORT`: dashboard port; defaults to `4173`
- `SCRAPER_HEADLESS`: use `false` for interactive login
- `SCRAPER_SCROLL_ROUNDS`: maximum scroll attempts per sweep
- `SCRAPER_SCROLL_DELAY_MS`: wait time between scrolls

## Operational notes

Threads can change its markup or rate-limit automated browsing. The scraper anchors itself to the stable pagelet prefix and link patterns instead of generated CSS class names, but it may still need maintenance if Threads changes its result structure.

Only HTTPS webhook URLs hosted by Slack or Discord are accepted. Webhook secrets are stored locally in `data/threadline.json`; protect that file and do not commit it.
