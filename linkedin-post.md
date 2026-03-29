Claude Code is awesome but hear me out... All coding agents are terrible at staying organized across a real feature.

You plan in one message, lose context three messages later, forget what was already reviewed, and end up babysitting the agent instead of shipping.

I built supipowers to fix that. It's an open-source extension for Oh-My-Pi (OMP) that gives your coding agent actual workflow structure through slash commands:

`/supi:plan` breaks features into tasks collaboratively
`/supi:run` dispatches parallel sub-agents with dependency awareness
`/supi:review` runs composable quality gates
`/supi:release` handles versioning and publish

One install, no config required:

bunx supipowers@latest

The agent stops being a smart autocomplete and starts working like a dev who follows process.

What you get:

→ Collaborative planning with automatic task breakdown
→ Parallel sub-agent execution with conflict detection
→ Composable code review (LSP diagnostics, AI review, custom gates)
→ Structured QA pipeline
→ One-command releases with version bump and notes
→ Interactive TUI for config and status
→ Self-updating from inside OMP

MIT licensed. Feedback welcome.

https://github.com/user/supipowers
