# keepwarm: prompt-cache keep-warm plugin for Claude Code

[中文](README.md) | English

Claude Code's prompt cache expires after about one hour of inactivity. The next request then has to write the whole context back into the cache, which on a long session can cost several dollars (or a noticeable slice of your subscription quota) in one go. This plugin shows how long the cache has been idle above the prompt box, lets you keep it warm with one click or on a timer, and adds a chart pane for context, cache, quota and cost.

The interface text is in Chinese. The screenshots below show the chart pane (labels translated in the captions).

| Cache writes (last 24 h, cumulative) | Cost breakdown (last 24 h, cumulative) | Context length (last 24 h, hourly) |
|:--:|:--:|:--:|
| ![Cache-write pane](docs/panel-cache-write.png) | ![Cost pane](docs/panel-cost.png) | ![Context pane](docs/panel-context.png) |

## Features

- **Idle notice**: above the prompt box, "cache idle for N min, expires in about M min", with buttons to keep warm once (保温一次) and open the charts (图表).
- **Commands**
  - `/keepwarm`: send one keep-warm request now (a very short fixed prompt that refreshes the cache).
  - `/keepwarm 8`: keep warm for 8 hours, sending one request whenever the session has been idle for 50 minutes. The timer restarts whenever you send a message. The maximum is 24 hours.
  - `/keepwarm off`: stop continuous keep-warm.
  - `/keepwarm chart`: open the chart pane.
- **Chart pane**
  - Four tiles at the top: current context, cache time left, 5-hour quota, weekly quota.
  - Three charts: cache timeline (cache writes in long ranges), cost breakdown, context length.
  - Time range: this session, 24 hours, 7 days, 30 days, 12 weeks, 12 months. Ranges other than "this session" cover all projects.
  - Cost and cache writes can switch between per-period bars and a cumulative curve. 24 hours and 7 days default to cumulative; longer ranges default to bars.

## Install

### Option 1: plugin marketplace (recommended)

Run these in a terminal, then start a new Claude Code session:

```bash
claude plugin marketplace add https://github.com/Ancean/claude-keepwarm.git
claude plugin install keepwarm@ancean-plugins
```

Inside a session you can also use `/plugin marketplace add Ancean/claude-keepwarm` and `/plugin install keepwarm@ancean-plugins`; if the shorthand cannot reach the repository (it goes over SSH), use the HTTPS URL above. To update: `claude plugin marketplace update ancean-plugins`, then `claude plugin update keepwarm@ancean-plugins`.

### Option 2: manual, in the skills directory

1. Clone this repository into `~/.claude/skills/keepwarm/` (on Windows `C:\Users\<you>\.claude\skills\keepwarm\`):

   ```bash
   git clone https://github.com/Ancean/claude-keepwarm.git ~/.claude/skills/keepwarm
   ```

   Make sure the path is `~/.claude/skills/keepwarm/.claude-plugin/plugin.json`, without an extra nested folder.

2. Restart the Claude desktop app or start a new Claude Code session. The plugin loads automatically as `keepwarm@skills-dir`.
3. To update, run `git pull` in that folder and start a new session.

Use only one of the two options; with both, the names clash and the second copy is not loaded.

## Requirements

- A Claude Code version that supports function-hook plugins (`modules` in `hooks.json`).
- `python` (3.8 or later, standard library only) available on the command line. Without Python, keep-warm still works but the chart pane reports a read error.

## Privacy and data

- Reads only usage numbers, timestamps, model names and compaction metadata from the local session logs (`~/.claude/projects/`). It **never reads conversation content** and uploads nothing.
- Long-range summaries cache those usage numbers per file in `~/.claude/keepwarm-cache/rows.json`. Deleting it is safe; it is rebuilt automatically.
- Keep-warm timestamps are kept in the plugin's own store, for the most recent 30 sessions only.

## How numbers are computed

- Costs are estimates at Anthropic list prices (Opus, Sonnet and Haiku tiers in `priceOf`), **not a bill**. On a subscription, read them as relative quota usage.
- A "cold read" (冷读取) is a request that rewrites the whole cache after more than one hour idle. Its extra cost is estimated as cache-write price minus cache-read price. Full rewrites after a compaction or a model switch are counted separately as "rebuild" (重建); keep-warm cannot prevent those.
- "Net saved by keep-warm" (保温净省) = cold-read cost avoided by keep-warm − cost of the keep-warm requests. Savings count only when a real message actually followed the keep-warm chain.
- The auto-compaction threshold is read from Claude Code. If it cannot be read, the fallback is 295K.

## Known limitations

- No keep-warm requests are sent while the computer sleeps or the Claude window is closed.
- Whether Claude Code clears the cache at some fixed time each day has not been verified, so continuous keep-warm is capped at 24 hours.
- Keep-warm requests from sessions older than the most recent 30 are counted as ordinary requests.

## License

MIT
