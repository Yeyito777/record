# record

A super-lean Discord terminal client bootstrap, inspired by Endcord and the Exocortex TUI stack.

Current scope:
- Bun + TypeScript
- raw terminal rendering
- modal editing with vim-style defaults
- token auth only

What it does right now:
- validate Discord tokens through `/login <token>`
- persist the saved token to `~/.config/record/config.json` (or `$XDG_CONFIG_HOME/record/config.json`)
- keep the config directory/file locked down to `0700` / `0600` permissions when possible
- run slash commands like `/login <token>`, `/logout`, and `/theme <name>`
- treat the prompt as message/command input only

Controls:
- `i`, `a`, `I`, `A`: enter insert mode
- `Esc`: return to normal mode
- `Enter`: submit the current message or slash command
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
