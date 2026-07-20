# record

A super-lean Discord terminal client bootstrap, inspired by Endcord and the Exocortex TUI stack.

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
- render the server tree as a collapsible sidebar
- show server voice/stage channels in the sidebar and join them from the terminal
- start DM voice calls with `/call`, leave with `/hangup`, and toggle `/mute` or `/deafen`
- watch a call participant's stream with `/watch` in a GPU-accelerated player window; close the window (or run `/watch` again) to stop watching
- run slash commands like `/login <token>`, `/logout`, `/refresh`, and `/theme <name>`
- treat the prompt as message/command input only

Controls:
- `Ctrl+M` or `Ctrl+S`: toggle the sidebar
- `Ctrl+J` / `Ctrl+K`: cycle between sidebar and chat container
- `Ctrl+N`: toggle chat focus between prompt and history
- `Shift+J` / `Shift+K`: jump the sidebar selection up/down from non-typing contexts
- `j` / `k` or arrow keys: move in the focused pane
- `Enter` in the sidebar: expand/collapse servers and categories, or open text channels
- `Enter` on a server voice/stage channel: join that voice chat
- `Shift+Enter` or `o` on a voice/stage channel: open its text chat without joining
- `;` on a server, category, channel, or voice member: open its actions (including permission-gated voice moderation)
- `m` on a server, category, channel, or voice member: toggle mute directly
- `i`, `a`, `I`, `A`: enter insert mode for the prompt
- `Esc`: return to normal mode
- `Enter` in the prompt: submit the current message or slash command
- `Tab` / `Shift+Tab`: cycle slash-command autocomplete
- `Ctrl+C` or `q` in normal mode: quit

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
- tokens are stored as plaintext for now, just with strict file permissions
- `/watch` playback prefers `mpv` (hardware decode via `--hwdec=auto-safe`) and falls back to `ffplay`; override with `RECORD_WATCH_PLAYER=mpv|ffplay`
- default theme is `whale`
- preview the cloned cerberus palette with `RECORD_THEME=cerberus bun run start`
- this is intentionally small and modular so real Discord features can be layered on later
