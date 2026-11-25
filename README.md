# confidence-meter

Shows a confidence meter beside the Claude Code prompt (and in the status line) so you can see, while Claude works through a complex plan, how sure it is about the step it is on.

Claude reports its confidence through a small tool, `report_confidence` (score 0-100, current step, one-line reason). The mod adds a short system-prompt section telling Claude to report at each step of a plan and whenever its confidence changes, and to calibrate honestly: 90+ only when verified, below 50 when guessing.

- Green ≥75, yellow 50-74, red <50; an arrow shows the trend since the last report.
- The reading dims once you send a new prompt, until Claude reports again.
- A toast pops up if confidence drops below 40.

This is the model's self-assessment, not a measured probability: treat it as a signal, not a guarantee.

## Install

In a terminal (works everywhere, including for the VS Code extension):

```bash
claude plugin marketplace add Msapkas/claude-confidence-bar
claude plugin install confidence-meter@claude-confidence-bar
```

Or, inside an interactive Claude Code terminal session:

```
/plugin install confidence-meter --marketplace Msapkas/claude-confidence-bar
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it available in every project).

Then start a new Claude Code session (in VS Code: open a new Claude conversation). The meter appears once Claude reports its first reading.

## Where it shows

- **Terminal (fullscreen layout) and Claude desktop app:** a colored bar right of the prompt.
- **VS Code and the mobile apps:** a row above the prompt.
- **Everywhere:** a status-line entry with the score and reason.
