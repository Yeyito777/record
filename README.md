# record

A lean Discord, WhatsApp, and Instagram terminal client, inspired by Endcord and the Exocortex TUI stack.

Current scope:
- Bun + TypeScript
- raw terminal rendering
- modal editing with vim-style defaults
- read-only Discord browsing

What it does right now:
- validate Discord tokens through `/login <token>`
- persist the saved token to `~/.config/record/config.json` (or `$XDG_CONFIG_HOME/record/config.json`)
- keep the config directory/file locked down to `0700` / `0600` permissions when possible
- load servers, categories, channels, and recent messages
- render Discord custom emoji inline with an aspect-preserving two-column footprint when the terminal reports Kitty graphics support
- autocomplete and send server custom emoji: type `:name`, then press `Tab` to insert the selected emoji inline in the prompt
- render the server tree as a collapsible sidebar, with server icons on terminals that support Kitty graphics
- show active announcement/public/private threads beneath their text or forum parent, with live updates and full read/send support
- show server voice/stage channels in the sidebar and join them from the terminal
- start DM voice calls with `/call`, leave with `/hangup`, and toggle `/mute` or `/deafen`
- watch a call participant's stream with `/watch` in a GPU-accelerated player window; close the window (or run `/watch` again) to stop watching
- run local slash commands like `/login <token>`, `/logout`, `/refresh`, and `/theme <name>`
- discover and run application commands registered by apps/bots in the active server
- browse every pinned message in the current Discord channel with `/pinned`
- create a public thread with `/thread <name>`; when replying to a message, the new thread is anchored to that message
- treat the prompt as message/command input only

Controls:
- `Ctrl+M` or `Ctrl+S`: toggle the sidebar
- `Ctrl+J` / `Ctrl+K`: cycle between sidebar and chat container
- `Ctrl+N`: toggle chat focus between prompt and history
- `;` in history visual/visual-line mode: quote the selection into the draft and focus the following line
- `r` in history normal mode or `Ctrl+R`: reply to the selected message with ping enabled
- `Shift+R` in history normal mode: reply without pinging; the prompt marks this with `NO-PING` (pinging replies have no badge)
- `:` in history normal mode: opens a `Reacting` prompt starting with `:`; type an emoji name, press `Tab` to choose it, then `Enter` to send. Your draft (including images and reply/edit context) is saved and restored on send or cancellation. Backspace at cursor zero, `Esc` in normal mode, or `Ctrl+Q` cancels
- Double-tap `Space` in history normal mode (within 400 ms): react with ❤️ without changing your draft. `/quickreact <emoji>` changes and saves this default (e.g. `/quickreact :thumbsup:`); `/quickreact` shows it
- `/react <emoji>`: add a reaction to the message selected in history (WhatsApp replaces your previous reaction); accepts Unicode, `:shortcodes:`, and Discord custom emoji via autocomplete. The prompt shows the captured target; `Ctrl+Q` cancels
- `/unreact <emoji>`: remove your reaction; on WhatsApp, `/unreact` alone removes your current reaction
- Reactions appear immediately, roll back on failure, and keep the last message's reaction row visible if you were already at the bottom
- `Shift+J` / `Shift+K`: jump the sidebar selection up/down from non-typing contexts
- `j` / `k` or arrow keys: move in the focused pane
- `Enter` in the sidebar: expand/collapse servers, categories and server folders, or open text channels (see [Server folders](#server-folders))
- `/arrows hide|show`: hide (default) or show the sidebar's `▸`/`▾` arrows; the choice persists
- `Enter` on a thread (shown with `↳`): open its timeline; posting automatically joins the thread when needed
- `Enter` on an authored “Started a thread” message in history: open and focus that thread
- `Ctrl+V` attaches the image on the clipboard: copied image data, an iPhone HEIC/HEIF photo (converted to JPEG with macOS's built-in `sips`, or ImageMagick with libheif elsewhere), or copied image files from Finder or a file manager (PNG, JPEG, GIF, WebP or HEIC; each attaches under its own name, never as the file icon). A copied file that is not an image shows a notice pointing to `/upload`. The terminal's own paste (OSC 5522 paste events) does the same; over SSH a copied file names a file on the other computer, so copy the image itself instead
- image attachments expand inline by default; press `Enter` on their filename or image rows to collapse/reopen one
- opening the full-image viewer shows the cached preview immediately at the image's final viewer size, then swaps in full-resolution pixels in place without resizing; `Enter` / `Esc` closes even while loading. Chat images stay placed behind the higher-z viewer rather than disappearing, and image placements are presented in the same synchronized update as the surrounding text.
- `/images hide|show`: keep images collapsed until opened manually, or restore automatic expansion; the selected mode persists
- `/pinned` in the prompt: replace history with the channel's pinned messages; `Enter` on one returns to channel history focused on it
- `Escape` from pinned history, or from the sidebar in normal mode: return to ordinary channel history
- `/thread <name>` in the prompt: create and open a public thread; if a reply is active, anchor it to that replied-to message, otherwise create a standalone thread
- `Enter` on a server voice/stage channel: join that voice chat
- `Shift+Enter` or `o` on a voice/stage channel: open its text chat without joining
- `;` on a server, category, channel, or voice member: open its actions (including permission-gated voice moderation)
- `m` on a server, category, channel, or voice member: toggle mute directly
- `e` / `Shift+E` on a Direct Message or WhatsApp conversation: move it up/down within its pinned or unpinned section
- `p` on a Direct Message or WhatsApp conversation: pin/unpin it
- `h` / `l` on a voice member's Volume action: lower/raise that user's playback volume by 10%; the per-user setting persists across sessions
- `-` / `+` / `=` on a selected voice member: lower/raise that user's playback volume by 10% directly
- `i`, `a`, `I`, `A`: enter insert mode for the prompt
- `Esc`: return to normal mode
- `Enter` in the prompt: submit the current message or slash command. In normal mode `Enter` never submits a half-typed command: `r<Enter>` splits the line and a pending find, operator, count or `g` is cancelled (as are other non-character keys like `Tab`)
- `Up` / `Down` in insert mode with the autocomplete popup open: choose from it like `Tab` / `Shift+Tab`
- Mouse: a click in the prompt focuses it (insert mode); a click in history focuses history with the cursor on the clicked character. Dragging in history selects text (visual mode; `y` yanks it, `Esc` clears it). A click on an inline image opens the viewer, on an attachment name shows or downloads it like `Enter`, and on a link or configured path opens it with your configured opener (nothing opens without one, as in demo mode); a click on a Discord invite only says to press `Enter`, so a stray click never joins a server. The pointer is a hand over what a click opens and an I-beam over other text
- The prompt grows to 10 rows as you type, but never past half of the space it shares with history
- Slash autocomplete matches anywhere in Record's command and macro names, and later words search their arguments: `/supp` finds `/noise-suppression`, `/stat idl` finds `/status idle`; the matched letters are accented. `Enter` on such a shorthand sends the popup's first row (`/stat idl` sets `/status idle`). Text that matches nothing (a thread name, an emoji, a status quote) is sent as typed, a lone one-letter `/s` stays a message, and `/quit`, `/hangup`, `/login` and `/logout` only run when typed out. App commands (`/@app …`) complete as before
- `Tab` / `Shift+Tab`: cycle autocomplete, including custom emoji choices; with nothing to complete, `Tab` in insert mode inserts a four-space soft tab, which `Backspace`/`Delete` remove in one press
- `>>` / `<<` in prompt normal or visual mode: shift the line (a count shifts that many lines) or the selected lines right/left by four spaces
- Prompt vim keys follow Vim: `j`/`k` (and `Up`/`Down`) move by displayed rows of wrapped lines, counts work before operators (`3dd`, `2d3w`), `f`/`F`/`t`/`T` with `;`/`,`, `^`, `o` in visual mode, and `yy`/`Vy` put back as whole lines with `p`/`P`. A bare `t` in normal mode stays the next-notification shortcut; after a count or operator it is the till motion
- Word motions (`w`/`b`/`e`, `iw`) treat letters and accents in any script as word characters; `V c` leaves an empty line like `cc`
- Yank and put use the system clipboard (pbcopy, wl-copy, xclip or xsel); without a working one (for example over SSH with no `DISPLAY`) they fall back to an in-memory register. A put never reads an image on the clipboard as text, and put or pasted text is cleaned of terminal control sequences, carriage returns and hard tabs (which become four spaces)
- A bracketed paste is its own undo step between the typing around it; `e` on a sent message replaces the draft, which `u` brings back
- `Ctrl+C` or `q` in normal mode: quit

### App/bot commands

Typing `/` in a server lazily loads that server's application-command index. Use `Tab` to choose the app, command, subcommand/group, option, and any available static or app-provided autocomplete choice.

The text form is app-qualified so commands with the same name from different bots cannot collide:

```text
/@app_name command [subcommand | group subcommand] --option=value
```

The `@` marks an app namespace so it cannot collide with Record's local slash commands. Spaces in an app name become underscores. Quote values containing spaces, for example `/@poll_bot create --question="tea or coffee?"`. User, role, and channel options accept Discord mentions or raw IDs. Attachment options consume images already attached to the prompt.

Run it:

```bash
bun install
bun run start
```

Voice calls use the bundled native Rust/C audio helper in `native/discord-voice-engine/`. Build and install it onto your normal `PATH` with:

```bash
bun run install:voice-engine
```

That installs `discord-voice-engine` to `~/.local/bin` by default, so Record and other local tools such as `discord-cli` can continue to discover it through `DISCORD_VOICE_ENGINE` or ordinary `PATH` lookup. Override the install prefix the same way as the helper Makefile, e.g. `bun run install:voice-engine -- PREFIX=/usr/local`.

Notes:
- custom emoji support uses direct-stream Kitty graphics, so it works over SSH without exposing local file paths; animated emoji use Discord's PNG first frame
- custom emoji autocomplete uses the active server's emoji for non-Nitro accounts and all joined servers' emoji for Nitro accounts
- tokens are stored as plaintext for now, just with strict file permissions
- expanded chat images use the Kitty direct-stream graphics protocol; PNGs are sent directly and other image formats use `ffmpeg` to produce a bounded first-frame PNG
- WhatsApp stickers expand inline like images, including first-frame previews of animated WebP stickers
- Initial WhatsApp history loading and older-page fetching show timeline spinners, including between pages; sending a message does not clear them.
- WhatsApp silently rechecks the open chat's recent 50-message window every minute to recover missed messages. Full caches and chats whose older history finished syncing also recheck on focus and reconnect, showing a bottom “Loading newer messages…” spinner until the request finishes without restarting completed backfills or moving scrolled-up readers.
- Late WhatsApp history/cache loads preserve sent messages, live edits, and the reading viewport.
- WhatsApp writes each outgoing message (including image bytes and exact message IDs) to a private durable outbox before sending. Quitting briefly drains acknowledgements before saving history. Interrupted sends survive restart as **delivery unconfirmed** until an exact echo/history match arrives; Record never automatically resends them. Confirmed outbox entries are removed only after the history cache is safely written. `/logout whatsapp` clears the outbox.
- downloaded Discord and WhatsApp attachments share a 100-file LRU cache; cache hits refresh their age and successful additions prune the oldest files
- switching chats reuses a session-only LRU of prepared image previews (64 entries / 16 MiB); terminal image data also stays resident for recent images (up to 64 idle images / 32 MiB, plus visible images), avoiding reconversion and retransmission on return
- `/watch` playback prefers `mpv` (hardware decode via `--hwdec=auto-safe`) and falls back to `ffplay`; override with `RECORD_WATCH_PLAYER=mpv|ffplay`
- default theme is `whale`
- runtime debug events go to `$XDG_CONFIG_HOME/record/debug.log`, written in batches and rotated to `debug.log.1` at 16 MiB (`RECORD_DEBUG_LOG_MAX_BYTES`); `RECORD_DEBUG=0` turns it off, `RECORD_DEBUG=verbose` also records per-packet/per-speaking-flip call and voice events
- `bun test` runs against a throwaway config/cache/home directory (bunfig.toml preload), never your real `~/.config/record`
- preview the cloned cerberus palette with `RECORD_THEME=cerberus bun run start`
- this is intentionally small and modular so real Discord features can be layered on later

### Scroll regions

When the message pane scrolls by less than its height (keys, wheel, or a new
message while following the bottom), Record tells the terminal to scroll just
the pane's rows (`DECSTBM` + `SU`/`SD`) and then draws only the rows that
scrolled into view, inside one synchronized update (mode 2026). Every terminal
gets fewer bytes. Inline images and custom emoji are re-placed at their new
rows in the same update.

A terminal region scroll moves whole rows (st, like most terminals, has no
left/right margins), so beside the sidebar or member list the panels' segments
of the moved rows are repainted in the same synchronized update. Record does
that only when the terminal confirms synchronized updates: at startup it asks
with DECRQM (`CSI ? 2026 $ p`), and on a reply of 1 or 2 region scrolls also
run beside the side panels and around overlays (the band is the longest run of
message rows no overlay touches; sidebar icons are placed back at their rows).
Without that confirmation a region scroll is used only while the pane spans the
full width with no overlay, and Record repaints changed rows otherwise, exactly
as before. Jumps of a pane height or more, resizes and full repaints are
unchanged either way.

#### Smooth scrolling (st)

On a terminal with app-driven smooth scrolling (st's mode 2032,
`~/Config/st/docs/app-smooth-scroll.md`) Record animates the message pane
itself, the way the Exocortex TUI animates its conversation. At startup it asks
with DECRQM (`CSI ? 2032 $ p`); if st says yes it turns the mode on
(`CSI ? 2032 h`) and off again on exit, quit, signals and crashes. Other
terminals never reply and see no difference.

- Each scroll is one frame: the region scroll to where the scroll ends, the
  rows it exposed, and one eased move (`OSC 2032 ; m`), in one synchronized
  update. st then animates the whole glide itself at the display's refresh
  rate (100 ms ease-out, like st's own glides), drawing the rows the scroll
  pushed out in the strip it uncovers. Record keeps the same curve to know
  where st is, sends nothing while it glides, and wakes once when it rests, so
  over ssh the glide never waits on Record and the traffic is one frame per
  scroll. (Exocortex lays its history out a row at a time because rows beside
  its Tasks panel re-wrap as they glide; Record's never re-wrap.) A scroll
  longer than the band minus three rows takes one more frame when due; a jump
  further than a screen repaints one screen away and glides in from there.
- What glides: every scroll key (`j`/`k` and other cursor motions that scroll,
  `Ctrl+E`/`Ctrl+Y`, `Ctrl+D`/`Ctrl+U`, page jumps, `gg`/`G`), the mouse wheel,
  messages arriving (or the typing line coming and going) while you follow the
  bottom, and history pages arriving while you scroll (the glide carries on).
  Jumps further than a screen glide in from one screen away.
- What snaps: channel and pinned-view switches, resizes, sends, toggles and
  anything else a key or click re-lays out, messages arriving below a
  scrolled-up view (nothing moves), and frames that had to be repainted.
- It works with the sidebar and member list open and around the autocomplete
  popup and other overlays: the scrolled band is the longest run of message
  rows no overlay touches, the moving rectangle (`OSC 2032 ; r`) is the pane's
  columns only, and the side panels' segments of the moved rows (and their
  server icons) are repainted in the same update, so they never move. That
  repaint is most of a scroll's bytes with the panels open (about 6 KB with
  the sidebar, 11 KB with both, under 1 KB with neither, at 240x50); st has no
  left/right margins (DECLRMM) to avoid it. If an overlay or the typing line
  changes the band's edge under a glide by more than a row, the rest of the
  glide snaps rather than uncover an empty strip.
- Inline images and custom emoji glide with their text. While a glide runs an
  image cut off by the pane's bottom is placed whole past the edge (st clips it
  to the moving rectangle) and one more frame crops it again when the glide
  ends; st keeps the rows of images leaving at the top. Custom emoji use one
  placement id per cell and are deleted one by one, so emoji on the lines st
  keeps for the glide's edge are not erased mid-glide.
- The sidebar and member list lists themselves do not glide: mode 2032 has one
  offset shared by every moving rectangle, so they could not move
  independently of the message pane.

The pinned-messages view is the same pane and glides the same way.

To turn region scrolls off (smooth scrolling included), set
`"scrollRegions": false` in `config.json` and restart. Record then emits exactly
what it did before region scrolls existed and never asks about modes 2026 or
2032. For testing, `RECORD_SMOOTH_SCROLL=off` keeps region scrolls but never
asks for st's mode 2032 (st then gets the plain region scrolls above).

### Sidebar icons

On terminals that answer Record's Kitty graphics query (such as st and Kitty),
each Discord server in the sidebar shows its icon in a two-cell box
in front of the name (after the expand arrow when `/arrows show` is on). Servers without an icon, and icons
still loading or unavailable, show a tile with the server's initials in the
same box. Direct-message rows show the other person's avatar (group DMs their
group picture) in place of the `#` marker; the Direct Messages, WhatsApp and
Instagram roots show DM / WA / IG tiles. WhatsApp chats show their profile or
group picture and Instagram one-to-one chats the other person's avatar;
Instagram groups and anyone without a picture get initials. Elsewhere the
sidebar looks exactly as before.

- Discord icons and avatars are 64 px PNGs from Discord's CDN (animated ones
  show their first frame). No login token is sent with these requests.
- A WhatsApp picture costs one normal profile-picture query (preview size)
  through the logged-in session, then a download of the URL it returns. An
  Instagram avatar is a download of the `profile_pic_url` the inbox already
  carried; no extra Instagram API call is made. JPEGs are converted to a
  small PNG with `ffmpeg` once, before caching.
- Only rows on screen are fetched, visible rows first, plus a little
  lookahead: about a screen for Discord, three rows for WhatsApp and
  Instagram. At most four Discord, two Instagram and one WhatsApp request are
  in flight at once.
- Pictures and "has no picture" answers (404, or a WhatsApp picture hidden by
  privacy) are kept in `~/.config/record/image-cache/sidebar/`, one file per
  server or chat, and reused after a restart without a request. Discord
  pictures are keyed by their hash and never go stale; WhatsApp and Instagram
  pictures are asked for again after 7 days, "no picture" after 3 days
  (WhatsApp) or 7 days (Instagram). A failed refresh keeps showing the old
  picture.
- After an error (offline, rate limit, server error) that platform pauses for
  a minute, doubling up to 30 minutes, and only rows still on screen are
  asked for again; nothing is retried in a loop. WhatsApp is never asked
  while disconnected.
- The terminal keeps icon data once sent (up to 256 off-screen icons /
  16 MiB), so scrolling, collapsing, toggling the sidebar or closing an
  overlay only places them again. An icon the terminal rejects three times
  falls back to its initials.
- The selected row's icon stays visible over the highlight. Icons under the
  image viewer are hidden while it is open; a resize or full repaint places
  every icon again.

### Server folders

Group servers into local folders (saved per account in
`accounts/<id>/server-folders.json`; nothing is sent to Discord). Folders open
as a tree, like Exocortex's sidebar: a folder expands in place with its
contents indented below it, folders nest, and a server inside a folder still
expands to its own categories and channels. A closed folder shows 📁, how many
servers it holds and the combined unread badge of everything inside it; an
open folder shows 📂 and leaves the badges to its rows. Which folders are open
is saved with the layout.

- `Enter` or a click: open/close the folder. `l` opens it, or steps onto its
  first row when it is already open. `h` / `Backspace` close it, or close the
  folder that lists the selected row and move onto it.
- Folder actions act on the folder that lists the selected row: `f` creates a
  folder there (with a `v` visual block, the block moves into it), `F` moves
  the selection to a folder (`..` is that folder's parent, `/` the top level),
  `<` moves it out to the parent, `e` / `Shift+E` reorder it among its
  siblings. `r` renames and `x` unwraps the selected folder. A visual block
  that covers a folder and rows inside it moves the folder only.
- `/folders navigate` switches to the older view where opening a folder shows
  only its contents (with a `..` row); `/folders tree` switches back. The
  choice is saved in `config.json` (`"sidebar": {"folders": ...}`).
- Search (`/`, `?`) lists matches flat in either view; opening a folder found
  by search clears the filter and opens it where it lives.

By default the sidebar draws no `▸`/`▾` arrows: rows start one column in and
each level indents two columns, so an open server or folder shows its rows
right below it and the selected row is marked by its highlight alone.
`/arrows show` brings back the arrows on servers and categories and the
cursor's `▸` (`"sidebar": {"arrows": ...}` in `config.json`).

### Instagram Direct

Run `/login instagram` for instructions, then paste your Instagram cookies:

```text
/login instagram sessionid=…; csrftoken=…; ds_user_id=…
```

Instagram uses session cookies, not a Discord-style bearer token. Sign in at
instagram.com in **any browser**, open DevTools → Network, reload the page,
and select a request to `www.instagram.com`. Copy its **Cookie** request header
value and paste it after `/login instagram ` in Record (not your shell).
The full header works, with or without the `Cookie:` prefix; it must contain
`sessionid`, `csrftoken`, and `ds_user_id` from the same session. A bare sessionid
alone is not supported. Treat these cookies like a password: never share them.
They are saved locally as plaintext with private file permissions.

Optional **vimbrowser** import: `/login instagram browser [tab ID]`.
For an isolated browser context, specify its signed-in Instagram tab ID.
The old `/login instagram <numeric tab ID>` shortcut also works.
Importing auth does not navigate or focus the browser.
Either login method reconnects automatically on subsequent launches.
If the Instagram section is empty, its status row distinguishes connecting,
logged out (`/login instagram`), and offline states. `/refresh` retries saved
auth even after an initial connection failure; transient network failures retry
automatically, while expired sessions and rate limits require user action.
Worktree logins remain isolated: after cleaning a test worktree, log in once
in main if main was not already linked.

Instagram has its own sidebar section, independent of Discord and WhatsApp.
It uses the same GraphQL API as instagram.com's own Direct inbox
(`/api/graphql`, with page tokens taken from the signed-in homepage); requests
identify as mobile Safari, the browser profile that API accepts without
desktop client hints. The sidebar lists individual and group chats with
Instagram's unread state and badges; the section badge counts unread chats.
Opening a chat loads its recent history and marks it read; scroll up for older
pages. Pin/reorder chats with the usual sidebar keys. The inbox is paginated at
startup and polled every 30 seconds (message requests less often); `/refresh`
updates immediately. Temporary failures retry with backoff and resume
unfinished pagination; HTTP errors show their status code without exposing
response contents.

Every message type is shown: photos, GIFs and stickers inline (terminal
graphics where supported), videos and voice notes as attachments you can open,
shared posts with their author/caption/preview, story shares and story replies
with their context ("Replied to your story"), links with previews, likes,
reactions, reply quotes, and calls as compact rows (`✕ ☎ Missed call`,
`☎ Video call ended`). Opening a shared reel plays just that one video, never a
feed. Disappearing/view-once media show a placeholder instead of downloading.

Type to send text; press `r` on a message to reply. `/react <emoji>` reacts to
the selected message and `/unreact` removes your reaction (Instagram allows
one reaction per person); double-space quick-reacts. Sends and reactions show
immediately and roll back if Instagram rejects them. A send that fails stays
in the chat as **failed** (the draft is restored); if the outcome is unknown
(for example, the connection dropped mid-send) it is marked **unconfirmed**.
Record never resends automatically; delete a failed/unconfirmed bubble with
`d` and resend it yourself if needed. Later messages wait behind a failed one
rather than overtaking it.

Message requests appear below the inbox as **Request · name**; open one to
read it without marking it seen, and `/accept` to move it into your inbox.
`/dm <username>` opens a new chat with an exact username match (or suggests
close matches); the first message creates the conversation.

Chats and recent history are cached per account in
`record/instagram/accounts/<user ID>/cache.json` (private permissions), so the
sidebar appears instantly at launch and then resyncs; unsent messages come
back as unconfirmed. If Instagram rotates its internal query IDs, Record
re-reads them from Instagram's public scripts and saves them in
`record/instagram/doc-ids.json`. Set `RECORD_INSTAGRAM_READONLY=1` to block
every write (sends, reactions, accepts and read receipts) for safe testing.

Press `m` on an Instagram chat, or use `;` → **Mute Locally / Unmute Locally**.
The sidebar and unread badges update immediately, even while disconnected.
This is Record-only: it never sends a mute request to Instagram. Local choices
override Instagram's mute flag, survive refresh/restarts, and are stored per
account in `record/instagram/accounts/<user ID>/local-mutes.json` under the
config directory. Logout keeps these preferences; worktrees remain isolated.
If a disk write fails, the choice stays active for the session and Record warns
that it could not be saved.

`/logout instagram` removes Record's saved session without signing out the
browser. Credentials are plaintext in
`$XDG_CONFIG_HOME/record/instagram/session.json` (default
`~/.config/record/instagram/session.json`), with `0700` directory / `0600` file
permissions. Worktree test sessions have their own config copy.

This uses Instagram's **unofficial web API**, which can change or be rate-limited.
If Instagram requests verification, complete it in your browser and log in again
with fresh cookies (or use the optional vimbrowser import).
Uploads, placing calls, declining requests, editing/unsending messages and
changing server-side mute settings are not supported. Call outcomes (missed,
declined, answered) are inferred from Instagram's wording of the call row.
Send, reaction, accept and read-receipt tests are mocked; testing never sends
messages to your contacts automatically.

## Development: offline demo mode

`scripts/dev/recorddemo` (or `bun run demo`, or `bun run src/main.ts --demo`,
or `RECORD_DEMO=1 bun run src/main.ts`) runs the real Record UI against a fake,
in-process Discord. Use it to look at and drive the TUI without any real
account:

- **No network.** Demo mode replaces `fetch` and `WebSocket` before any other
  module loads. Discord API/CDN/gateway requests are answered locally; every
  other request is refused. WhatsApp login is disabled (it runs in a separate
  Node process), and the demo config disables link/file openers.
- **No real config.** Each run uses a fresh temporary `XDG_CONFIG_HOME`
  (deleted on exit) holding a demo token. Demo mode refuses to start if the
  directory overlaps `~/.config/record` or `$XDG_CONFIG_HOME/record`, or if
  `RECORD_DEMO_HOME` is a non-empty directory it did not create.
- **Synthetic data** (fixed seeds, so screenshots are comparable): 15 servers
  (12 with generated icons) in nested server folders (Dev/ open, holding
  Tools/ and Tools/Archive/; Chill/ closed), categories, text/announcement/forum/voice
  channels, threads, voice members, DMs and group DMs with avatars, member
  lists with hoisted roles, unread and mention badges, a muted server. Histories
  range from empty to 2,400 messages (`Record Lounge / #general`) and a
  1,500-message DM, with inline images of many sizes and aspect ratios, custom
  emoji, stickers, reactions, replies, embeds, code blocks, markdown and long
  wrapped lines. Older pages load with a 450 ms delay.
- **Live traffic.** Sends, edits, deletes and reactions update the fake server
  and echo back through the gateway like Discord does. Send `!demo more 20` to
  receive 20 messages in the open channel, `!demo typing` for a typing
  indicator, `!demo every 3` for one message every 3 s (`!demo every 0` stops).
  `kill -USR1 <pid>` appends one message, `-USR2` ten; the pid is in
  `<demo home>/record-demo.pid`.

Visual testing in a nested X server (never on the host display):

```sh
scripts/dev/recorddemo --nested demo        # dwm start demo + st running the demo
dwm -e demo screenshot -o /tmp/record-demo.png
dwm -e demo key j                           # send keys; type text with:
printf 'hello\n' | dwm -e demo type
dwm -e demo key ctrl+c                      # quit Record (deletes the demo home)
dwm stop demo
```

`--nested` prints the demo home, pid file and these commands. Options are
environment variables: `RECORD_DEMO_OPEN=images` (channel name to open first;
`dm` for the long DM, `none` for nothing), `RECORD_DEMO_INCOMING_SECONDS=N`,
`RECORD_DEMO_OLDER_DELAY_MS`, `RECORD_DEMO_LATENCY_MS`, `RECORD_DEMO_NOW`
(end of the synthetic history), `RECORD_DEMO_HOME=DIR` (keep and reuse a demo
home) and `RECORD_DEMO_KEEP=1`. Each demo home has a `record/demo.log` of every
request the fake server answered. The CDN serves PNG bytes for every image URL
(icons, avatars, emoji, stickers, attachments), whatever the extension.
