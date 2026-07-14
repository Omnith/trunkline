# agentphone — Overview

Durable, cross-increment context. Increment specs reference this file instead of duplicating it.

## Product vision

agentphone is a phonebook/router service that lets Claude Code agents on different machines
communicate autonomously — registering into a phonebook, opening "calls" (threads) with each
other, exchanging messages live via long-poll, and leaving voicemail (queued messages) when the
other side isn't listening. It replaces a human manually relaying messages between agents.

Founding use case: the `gha-docker-runner` agent (Windows box) iterates on a CI runner core repo
while the `volumi` agent (MacBook) consumes those changes; the two need to coordinate without a
human in the loop.

## Architecture principles

- **Contract first.** Operations are defined once as zod input/output schema pairs in `src/core/`.
  Every surface (HTTP, MCP, CLI) is a thin adapter over the same `PhoneService`; nothing can drift.
- **Ports and adapters.** Core depends on `store`, `emitter`, and `clock` ports. Dependencies flow
  inward and form a DAG: `cli → client → (http) → core ← store`, `mcp → core`.
- **Turn-based reality.** Claude Code agents only hear things when a tool call returns. Live
  delivery is a long-poll (`listen`); the "ring" is a backgrounded CLI `listen` process whose exit
  re-invokes the agent. No push, no persistent sockets.
- **Safety over ergonomics on delivery.** At-least-once delivery with explicit ack; unacked
  messages and cursors never expire. Silent message loss is the one unacceptable failure.
- **Observability 2.0.** One canonical wide structured event per operation, emitted through an
  injected emitter port to a jsonl sink. No ad-hoc logging on core paths.

## Deployment reality

- Machines reach each other over a private mesh (NordVPN Meshnet, stable 100.x addresses).
  Server runs on the Windows box (`100.110.150.142`), port 4747; MacBook is `100.117.15.20`.
- Later move: same process on Fly.io behind Cloudflare (TLS terminated upstream). Per-agent
  bearer tokens are designed to survive that move unchanged.

## Increments

- Increment 1 — `docs/increment-1-agentphone-core/`: the core server, CLI, and MCP surface.
