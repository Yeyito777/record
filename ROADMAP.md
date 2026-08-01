# record roadmap

A lean Discord terminal client with the Exocortex TUI feel.

## Current state

Already done:
- raw terminal app in Bun + TypeScript
- vim-style prompt editing
- slash command system
- `/login <token>` and `/logout`
- theme system with `whale` and `cerberus`
- sidebar shell + Exocortex-style layout

Current limitations:
- no real Discord session beyond token validation
- no server/channel population
- no message timeline
- no message sending

## Principles

- keep the stack small
- keep modules narrow and composable
- prefer Exocortex/TUI interaction patterns where they fit
- make read-only browsing solid before piling on write features
- avoid overbuilding abstractions until they are actually needed

## Milestone 1 — usable read-only client

Goal: make record actually useful for browsing Discord.

### 1. Discord session bootstrap
- [ ] add a real Discord client/session layer
- [ ] validate token and fetch `@me`
- [ ] fetch guilds and private channels
- [ ] establish a gateway connection
- [ ] keep basic session state in sync
- [ ] reconnect cleanly on disconnects

### 2. Sidebar becomes real
- [ ] populate the sidebar with servers
- [ ] add selection state for the active server
- [ ] add a second pane or sub-list for channels in the selected server
- [ ] show unread / mention indicators where possible
- [ ] support keyboard navigation for the sidebar and channel list

### 3. Channel view
- [ ] fetch messages for the selected channel
- [ ] render a real message timeline
- [ ] support scrolling through history
- [ ] show author, timestamp, and message grouping
- [ ] support loading older history on demand

At the end of this milestone, record should be good enough to log in, browse servers, open channels, and read messages.

## Milestone 2 — basic messaging

Goal: make record usable for day-to-day posting.

- [ ] send normal text messages
- [ ] keep the prompt as the main composer
- [ ] show optimistic local send state
- [ ] update timeline from gateway events
- [ ] add drafts per channel
- [ ] support replying to a message
- [ ] support editing and deleting your own messages

At the end of this milestone, record should feel like a serious minimal client.

## Milestone 3 — navigation and TUI ergonomics

Goal: bring over the best Exocortex-style UX ideas.

- [ ] panel focus model for sidebar / channel list / history / prompt
- [ ] stronger vim navigation outside the prompt
- [ ] jump to unread / mentions / latest
- [ ] command-driven navigation (`/server`, `/channel`, `/jump`, etc.)
- [ ] better autocomplete and command discoverability
- [ ] search within messages
- [ ] status/overlay polish where helpful

## Milestone 4 — Discord essentials

Goal: cover the features a terminal Discord client really needs.

- [ ] attachments upload flow
- [ ] attachment download/open helpers
- [ ] reactions
- [ ] typing indicators
- [x] thread browsing basics
- [ ] DMs and group DMs
- [ ] pinned messages / channel topic display

## Milestone 5 — local state and robustness

Goal: make the client fast and reliable.

- [ ] local cache for guilds, channels, and recent messages
- [ ] startup restore into last-open location
- [ ] rate-limit aware request queue
- [ ] better error surfaces and recovery paths
- [ ] structured logging / debug mode
- [ ] tests around input parsing, rendering, and state reducers

## Nice-to-haves

- [ ] theme customization beyond bundled themes
- [ ] user keybind customization
- [ ] image preview helpers via external tools
- [ ] notifications / bell hooks
- [ ] multi-account support
- [ ] plugin or scripting hooks

## Explicitly not urgent right now

- voice
- video
- rich embedded media rendering
- full parity with the desktop client

## Suggested build order

1. session + gateway bootstrap
2. servers sidebar data
3. channels list
4. message timeline
5. sending messages
6. replies / edit / delete
7. unread + search + polish

## Definition of “first truly usable version”

record v0 should be able to:
- log in with `/login <token>`
- show servers and channels
- open a channel
- read recent history and scroll back
- send messages
- recover from disconnects without falling apart
