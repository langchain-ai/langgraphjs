# Protocol Scenario Validation

This directory contains scenario files that validate the Agent Streaming
Protocol against real-world use cases. Each file describes a scenario,
shows implementation code, and compares v1 (current) vs v2 (protocol)
capabilities.

| Scenario | File | Key Validation |
|----------|------|----------------|
| Simple ReAct agent | [01-react-agent-tool-calling.md](./01-react-agent-tool-calling.md) | Basic tool calling with turns, v1 parity |
| Multimodal story creation | [02-multimodal-story-creation.md](./02-multimodal-story-creation.md) | Text + image + audio subagents, binary streaming |
| Fan-out progress dashboard | [03-fan-out-progress-dashboard.md](./03-fan-out-progress-dashboard.md) | Hundreds of subagents, lifecycle tracking |
| Human-in-the-loop approval | [04-human-in-the-loop-approval.md](./04-human-in-the-loop-approval.md) | In-band interrupt/resume |
| Deep agent sandbox coding | [05-deep-agent-sandbox-coding.md](./05-deep-agent-sandbox-coding.md) | File access, terminal streaming, iterative dev |
| Reconnection mid-run | [06-reconnection-mid-run.md](./06-reconnection-mid-run.md) | Disconnect/reconnect, event replay |
| Cost-controlled research | [07-cost-controlled-research.md](./07-cost-controlled-research.md) | Per-agent budgets, usage streaming |

See the [Protocol Design](./design.md) and
[Implementation Plan](./implementation.md) for the full specification.
