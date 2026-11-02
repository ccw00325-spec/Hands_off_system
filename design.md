# Agent Control Tower

v0.6 current layout and rationale: [desktop workbench research](docs/design-research.md). The fixed three-panel description below records the earlier design baseline; current teams support 2–4 panels and multiple roles per panel.

Use the user's approved desktop layout: black engineering workspace; planning agent full-width above two implementation agents; dispatch strip between them; projects and connection settings upper-right. Keep future orchestration clearly unavailable until implemented.

Audience: a student building locally and later sharing the application on GitHub.
Primary task for v0.1: connect a ChatGPT account through the official system-browser authorization flow and separately register a personal image API key once.

Theme: Terminal, adapted to the established control-tower layout. No ornamental gradients, fake shell output, or simulated success. Neutral black surfaces, restrained mint status, amber warnings. System Korean sans for prose, system monospace for technical labels. All colors and fonts consume CSS tokens. Keyboard focus, reduced motion, error, loading, disabled and empty states are explicit.
