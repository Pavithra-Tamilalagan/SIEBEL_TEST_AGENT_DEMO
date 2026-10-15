# Dependency Diagram

The following diagram shows agent execution flow and dependencies.

```mermaid
flowchart LR
  User["User (Copilot Chat trigger)"] -->|Trigger Phrase| Orchestrator["Orchestrator Agent"]
  Orchestrator --> InputAgent["Input Agent"]
  Orchestrator --> PlaywrightGen["Playwright Generator Agent"]
  Orchestrator --> ExecutionAgent["Execution Agent"]
  ExecutionAgent --> ArtifactAgent["Artifact Agent"]
  ExecutionAgent --> FigmaValidator["Figma Validator Agent"]
  Orchestrator --> ReportGen["Report Generator Agent"]
  ReportGen --> Report["Report (CSV / Excel / JSON)"]
  ArtifactAgent --> Report
  FigmaValidator --> Report
```

- Flow: User -> Orchestrator -> Child Agents -> Report
- Artifact contract: all agent-to-agent communication happens via `output/agents/*.json` artifacts and `output/artifacts/<TOM>/` folders.
