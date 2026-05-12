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
- run slash commands like `/login <token>`, `/logout`, `/refresh`, and `/theme <name>`
- treat the prompt as message/command input only

Controls:
- `Ctrl+M` or `Ctrl+S`: toggle the sidebar
- `Ctrl+J` / `Ctrl+K`: cycle between sidebar and chat container
- `Ctrl+N`: toggle chat focus between prompt and history
- `Shift+J` / `Shift+K`: jump the sidebar selection up/down from non-typing contexts
- `j` / `k` or arrow keys: move in the focused pane
- `Enter` in the sidebar: expand/collapse servers and categories, or open channels
- `Enter` on a server voice/stage channel: join that voice chat
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

Notes:
- tokens are stored as plaintext for now, just with strict file permissions
- default theme is `whale`
- preview the cloned cerberus palette with `RECORD_THEME=cerberus bun run start`
- this is intentionally small and modular so real Discord features can be layered on later
