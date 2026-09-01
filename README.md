# Rift Atlas Companion

A Chrome extension that adds a small panel to the [Rift Atlas](https://play.riftatlas.com/) lobby — the most-used online simulator for Riot's TCG **Riftbound**.

[繁體中文](README.zh-TW.md)

Keywords: Riftbound, Rift Atlas, deck legality, format check, room code, matchmaking, lobby, browser extension.

## Why this exists

Rift Atlas has random matchmaking, but it can't be limited to a format — you play whoever you get, with whatever they brought. It also lets you share a room code, but only if you already have someone to send it to. The gap in between — *wants a specific format, has nobody to play with yet* — currently gets solved by shouting in a Discord server, which nobody outside that server can hear.

This extension fills that gap with three things:

- **Deck legality against the current format.** Reads the card numbers off the deck panel and flags anything outside the format the site tracks.
- **Post your room code to a public board**, instead of copying it, switching tabs and pasting it somewhere.
- **See who else is waiting**, and join them in one click.

The board itself lives at [Riftbound Chronicle](https://riftbound.chroniclecore.com/rooms) and works without the extension — anyone can read it and join a room. What the extension saves you is the copy-pasting and the manual card-checking.

## Install

Not on the Chrome Web Store yet. Load it unpacked:

1. Download or clone this folder.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Reload `play.riftatlas.com`. A collapsed bar appears in the bottom-right; click it to expand.

The panel starts collapsed because it sits next to Rift Atlas's own "join / spectate" controls and would cover them. The collapsed bar still shows how many people are currently waiting.

## Development

To point the extension at a local site instead of production, don't edit `SITE` in `background.js` — that line will eventually get committed, and then every user's extension tries to reach port 3000 on their own machine. Use the setting instead:

1. Add `"http://localhost:3000/*"` to `host_permissions` in `manifest.json` and reload the extension.
2. On `chrome://extensions`, open this extension's **service worker** console and run:

```js
chrome.storage.local.set({ siteOverride: "http://localhost:3000" })
```

Clear it to go back to production:

```js
chrome.storage.local.remove("siteOverride")
```

After editing `content.js`, reload the extension *and* refresh the Rift Atlas tab. Editing `background.js` only needs the reload.

## What it reads, and what it sends

It reads pages on a site you don't own, so this should be stated plainly — and it's the reason the source is open. Every claim below is checkable against the files in this repo.

**On play.riftatlas.com it reads two things**, both staying in your browser:

- `localStorage`, key `riftbound_simulator_last_room` — your current room code.
- The image URLs of cards in the deck panel, to extract card numbers such as `OGN-004`. Card numbers rather than names, because the interface is Simplified Chinese and names don't map cleanly across localizations.

**On riftbound.chroniclecore.com it reads one thing**: the Supabase session the site itself stores in `localStorage`, copied into extension storage by `auth-bridge.js`. That is how the panel can post a room on your behalf without asking you to log in again. It never sees your password — logging in happens on the site, and this only copies the resulting session. Log out and the copy is dropped.

**It talks to `riftbound.chroniclecore.com` and nowhere else**, always without cookies (`credentials: "omit"`):

- `GET /api/rooms` — rooms currently posted to the board.
- `GET /api/card-sets` — which set belongs to which wave, and which wave is currently on sale. Cached for a day. This lives on the site rather than being hardcoded here, so a new set releasing doesn't require you to update the extension.
- `POST /api/rooms` — **only when you press "post to the board"**, and it sends only what you filled in: room code, display name, format, match type and the optional note. Authenticated with the session above.
- `DELETE /api/rooms` — only when you press "take down".

**Your decks and game state are never sent anywhere.** The legality check runs entirely in your browser; the card numbers it reads are never transmitted. There is no telemetry and no analytics. Nothing leaves the browser except the fields you typed, at the moment you press the button. Every outbound request is in `background.js`; reading that one file tells you the whole story.

## What it doesn't do

- It does not press any Rift Atlas button for you, modify game state, or automate any part of play.
- It does not enforce rules, adjudicate interactions, or tell you how to play.
- Sets it doesn't recognise are reported as "unrecognised", never as illegal — this extension can be older than the site, and the worst case should be silence rather than a false accusation.

## License and disclaimer

MIT.

**This is a third party to a third party.** Riftbound is Riot Games' game. Rift Atlas is an unofficial community simulator, not run by Riot. This extension is an unofficial add-on to Rift Atlas, not run by them either — it reads their public pages and adds a panel, nothing more. Three separate parties, no affiliation between any of them.

So, explicitly: not affiliated with, endorsed or sponsored by Riot Games, and not affiliated with, endorsed or sponsored by Rift Atlas. Riftbound is the property of Riot Games; this project uses that IP under Riot's "Legal Jibber Jabber" policy. Bugs in this extension are ours — please report them here, not to Rift Atlas.

Built by [Riftbound Chronicle](https://riftbound.chroniclecore.com), a Traditional Chinese fan site for Riftbound.
