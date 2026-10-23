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
- render the server tree as a collapsible sidebar
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
- `Enter` in the sidebar: expand/collapse servers and categories, or open text channels
- `Enter` on a thread (shown with `↳`): open its timeline; posting automatically joins the thread when needed
- `Enter` on an authored “Started a thread” message in history: open and focus that thread
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
- `Enter` in the prompt: submit the current message or slash command
- `Tab` / `Shift+Tab`: cycle autocomplete, including custom emoji choices; with nothing to complete, `Tab` in insert mode inserts a four-space soft tab, which `Backspace`/`Delete` remove in one press
- `>>` / `<<` in prompt normal or visual mode: shift the line (a count shifts that many lines) or the selected lines right/left by four spaces
- Prompt vim keys follow Vim: `j`/`k` (and `Up`/`Down`) move by displayed rows of wrapped lines, counts work before operators (`3dd`, `2d3w`), `f`/`F`/`t`/`T` with `;`/`,`, `^`, `o` in visual mode, and `yy`/`Vy` put back as whole lines with `p`/`P`. A bare `t` in normal mode stays the next-notification shortcut; after a count or operator it is the till motion
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
- preview the cloned cerberus palette with `RECORD_THEME=cerberus bun run start`
- this is intentionally small and modular so real Discord features can be layered on later

### Scroll regions

When the message pane scrolls by less than its height (keys, wheel, or a new
message while following the bottom), Record tells the terminal to scroll just
the pane's rows (`DECSTBM` + `SU`/`SD`) and then draws only the rows that
scrolled into view, inside one synchronized update (mode 2026). Terminals that
animate region scrolls, like st's smooth-scroll branch, glide the pane; every
terminal gets fewer bytes. Inline images and custom emoji are re-placed at
their new rows in the same update.

A terminal region scroll moves whole rows (st has no left/right margins), so
this applies only while the pane spans the full width: with the sidebar or
member list open, or an overlay over the pane, Record repaints changed rows as
before. Jumps of a pane height or more, resizes and full repaints are also
unchanged.

To turn it off, set `"scrollRegions": false` in `config.json` and restart.
Record then emits exactly what it did before this feature.

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
