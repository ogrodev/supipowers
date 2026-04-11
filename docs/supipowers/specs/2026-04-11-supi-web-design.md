# `/supi:web` — Web Interface for OMP Agent Sessions

## Context

Supipowers currently operates through the terminal TUI. `/supi:web` adds a browser-based chat interface that controls a full OMP agent session — chat, model controls, tool execution, todos, and session stats — through a WebSocket bridge powered by the OMP SDK.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  OMP Terminal Session                                │
│  └── /supi:web  →  spawns detached server process   │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  Web Server Process  (standalone Bun)                │
│                                                      │
│  ┌──────────┐   ┌──────────────┐   ┌────────────┐  │
│  │ HTTP     │   │ WebSocket    │   │ OMP SDK    │  │
│  │ (static  │   │ Bridge       │◄─►│ Agent      │  │
│  │  files)  │   │              │   │ Session    │  │
│  └──────────┘   └──────────────┘   └────────────┘  │
└─────────────────────────────────────────────────────┘
         ▲                ▲▼
         │                │
┌────────┴────────────────┴───────────────────────────┐
│  Browser (React + Vite)                              │
│  ┌─────────┐  ┌──────────┐  ┌─────────────────────┐│
│  │ Chat    │  │ Controls │  │ Session Dashboard   ││
│  │ Panel   │  │ Panel    │  │ (todos, stats, ctx) ││
│  └─────────┘  └──────────┘  └─────────────────────┘│
└─────────────────────────────────────────────────────┘
```

### Why SDK Over RPC

The OMP SDK (`@oh-my-pi/pi-coding-agent`) provides full in-process control:

- `session.subscribe()` streams all `AgentSessionEvent` types (messages, tools, compaction, todos)
- Direct method calls: `prompt()`, `steer()`, `followUp()`, `abort()`, `dispose()`
- `setToolUIContext()` lets tools/extensions surface UI requests to the web frontend
- Direct `ModelRegistry`/`AuthStorage` access for model management UI
- Full TypeScript type safety — no protocol parsing
- Discovery helpers for extensions, skills, MCP servers, context files

RPC mode provides the same agent capabilities but adds subprocess management, stdin/stdout parsing, and loses direct API access. SDK is strictly more powerful with the same dependency.

## Components

### Server Side (`src/web/`)

#### `src/web/server.ts` — Entry Point

Standalone Bun process. Responsibilities:

1. Import OMP SDK (`createAgentSession`, `SessionManager`, `ModelRegistry`, etc.)
2. Create and manage `AgentSession` instances
3. Serve React static files from `dist/web/`
4. Accept WebSocket connections and bridge to session
5. Write `.server-info` file for the extension command to detect readiness

Startup:
```
bun src/web/server.ts --cwd <project-dir> --port <auto>
```

Reads environment: `SUPI_WEB_CWD`, `SUPI_WEB_PORT`, `SUPI_WEB_HOST`.

#### `src/web/session-bridge.ts` — Session ↔ WebSocket Bridge

Maps between OMP's `AgentSessionEvent` types and the WebSocket protocol:

- Subscribes to `session.subscribe()` — translates events to frontend-friendly messages
- Receives client commands — dispatches to session methods
- Tracks streaming state for UI indicators
- Handles concurrent prompts (steer/followUp when streaming)

State machine per session:
```
idle → prompting → streaming → idle
                 → streaming → tool_executing → streaming → idle
```

#### `src/web/protocol.ts` — WebSocket Message Types

Client → Server commands:
```typescript
type ClientMessage =
  | { type: "prompt"; message: string }
  | { type: "abort" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: string }
  | { type: "new_session" }
  | { type: "get_state" }
  | { type: "get_messages" }
  | { type: "compact"; instructions?: string }
  | { type: "extension_ui_response"; id: string; value?: string; confirmed?: boolean; cancelled?: boolean };
```

#### Shared Protocol Types

```typescript
/** Snapshot of session state sent on connect and after mutations */
interface WebSessionState {
  model: { provider: string; id: string } | null;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
  isStreaming: boolean;
  isCompacting: boolean;
  sessionId: string;
  sessionName: string | undefined;
  autoCompactionEnabled: boolean;
  messageCount: number;
  todoPhases: TodoPhase[];
  availableModels: Array<{ provider: string; id: string }>;
}

/** Minimal todo types mirrored from OMP */
interface TodoPhase {
  id: string;
  name: string;
  tasks: TodoTask[];
}

interface TodoTask {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "abandoned";
  details?: string;
  notes?: string;
}

/** A flattened chat message for the frontend (not OMP's internal AgentMessage) */
interface SerializedMessage {
  id: string;
  role: "user" | "assistant" | "tool_result";
  content: string;             // rendered text (markdown)
  thinking?: string;           // thinking block text, if any
  toolCalls?: SerializedToolCall[];
  timestamp: number;
}

interface SerializedToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: string;
  isError: boolean;
}
```

Server → Client events:
```typescript
type ServerMessage =
  // Session state
  | { type: "state"; data: WebSessionState }
  | { type: "ready" }
  | { type: "error"; message: string }
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end" }
  // Message streaming
  | { type: "message_start"; role: "assistant" | "tool_result" }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "message_end"; message: SerializedMessage }
  // Tool execution
  | { type: "tool_start"; toolName: string; toolCallId: string; input: unknown }
  | { type: "tool_update"; toolCallId: string; content: string }
  | { type: "tool_end"; toolCallId: string; result: unknown }
  // Extension UI
  | { type: "extension_ui_request"; id: string; method: string; [key: string]: unknown }
  // Session management
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  | { type: "todo_update"; phases: TodoPhase[] };
```

The protocol is intentionally simpler than OMP's internal `AgentSessionEvent`. The bridge flattens nested event structures into frontend-friendly flat messages. The frontend never sees OMP internal types.

#### `src/web/ui-context.ts` — Extension UI Bridge

Implements the UI context interface that `setToolUIContext()` expects. When tools or extensions call `ctx.ui.select()`, `ctx.ui.confirm()`, etc., this bridges them to the browser:

1. Tool calls `ctx.ui.confirm("Delete file?", "path/to/file")` in the agent session
2. UI context sends `extension_ui_request` to WebSocket client
3. Browser renders a confirmation dialog
4. User clicks confirm/cancel → `extension_ui_response` sent back
5. UI context resolves the promise → tool continues

Also handles: `notify`, `setStatus`, `setWidget`, `input`, `select`, `editor`.

### Command (`src/commands/web.ts`)

The `/supi:web` slash command. Registered as a TUI-only command (no LLM turn).

Flow:
1. Check if a web server is already running for this project:
   - Read `.omp/supipowers/web/.server-info` for port/PID
   - **Validate the PID is alive** (`process.kill(pid, 0)`) — if dead, clean up stale files and proceed to spawn
2. If running and alive, notify user with URL
3. If not, spawn `bun src/web/server.ts` as detached process
4. Poll for `.server-info` file (up to 10s)
5. Notify user: "Web interface running at http://localhost:PORT"
6. Optionally open browser (`open` on macOS / `xdg-open` on Linux)

Stop: `/supi:web --stop` kills the server process (reads PID from `.server.pid`).

### Frontend (`web/`)

React + Vite app. Built at package build time → output to `dist/web/`.

#### Layout

```
┌──────────────────────────────────────────────────────────────┐
│  Header: Session name | Model selector | Thinking | ⚙️ Stop  │
├──────────────────────────────┬───────────────────────────────┤
│                              │                               │
│  Chat Panel                  │  Dashboard Panel              │
│  ┌────────────────────────┐  │  ┌─────────────────────────┐  │
│  │ Message history        │  │  │ Todos                   │  │
│  │ (scrollable)           │  │  │ ├ Phase 1               │  │
│  │                        │  │  │ │  ☑ Task 1             │  │
│  │ [streaming indicator]  │  │  │ │  ◉ Task 2 (active)    │  │
│  │                        │  │  │ │  ☐ Task 3             │  │
│  │ Tool execution cards   │  │  │ └─────────────────────  │  │
│  │ Extension UI dialogs   │  │  │                         │  │
│  └────────────────────────┘  │  │ Session Stats           │  │
│  ┌────────────────────────┐  │  │ ├ Messages: 24          │  │
│  │ Input box   [Send] [⏹] │  │  │ ├ Context: 45k tokens  │  │
│  └────────────────────────┘  │  │ └ Model: claude-sonnet  │  │
│                              │  └─────────────────────────┘  │
└──────────────────────────────┴───────────────────────────────┘
```

#### Component Tree

```
App
├── Header
│   ├── SessionName
│   ├── ModelSelector
│   ├── ThinkingToggle
│   └── StopButton
├── ChatPanel
│   ├── MessageList
│   │   ├── UserMessage
│   │   ├── AssistantMessage (with streaming)
│   │   ├── ToolExecutionCard
│   │   └── ExtensionUIDialog
│   └── InputBox
└── DashboardPanel
    ├── TodoList
    ├── SessionStats
    └── ContextUsage
```

#### Key React Components

**`MessageList`** — Renders chat history. Handles:
- User messages (simple text bubbles)
- Assistant messages (markdown rendering, streaming text deltas, thinking blocks)
- Tool execution (collapsible cards showing tool name, input, output)
- Extension UI requests (inline dialogs — confirm/select/input)

**`InputBox`** — Text input with send button. Features:
- Multi-line input (Shift+Enter for newline, Enter to send)
- Abort button visible during streaming
- Disabled state when agent is processing

**`ModelSelector`** — Dropdown populated from `get_state` response. Sends `set_model` command on change.

**`TodoList`** — Renders todo phases/tasks from session state. Updated via `todo_update` events.

#### State Management

Single `useSession` hook manages all WebSocket state:

```typescript
function useSession(url: string) {
  // Connection state
  const [connected, setConnected] = useState(false);
  // Chat messages (accumulated from events)
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Streaming state
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  // Session state (from get_state)
  const [sessionState, setSessionState] = useState<WebSessionState | null>(null);
  // Extension UI requests pending user response
  const [pendingUI, setPendingUI] = useState<ExtensionUIRequest[]>([]);
  // Commands
  const send = useCallback((msg: ClientMessage) => ws.send(JSON.stringify(msg)), [ws]);
  const prompt = useCallback((text: string) => send({ type: "prompt", message: text }), [send]);
  const abort = useCallback(() => send({ type: "abort" }), [send]);
  // ...
}
```

#### Build & Bundling

- `web/vite.config.ts` — output to `../../dist/web/` (relative to web/ dir)
- `web/package.json` — React, Vite, minimal deps (devDependencies only for build)
- Built during `bun run build` via a `build:web` script that runs `cd web && bun run build`
- The `package.json` `files` array includes `dist/web/` so the built frontend ships with the npm package
- Server serves `dist/web/` directory as static files
- Dev mode: `bun run dev:web` starts Vite dev server with HMR + proxy to the Bun backend

## File Structure

```
src/
├── web/
│   ├── server.ts              # Standalone Bun server entry point
│   ├── session-bridge.ts      # AgentSession ↔ WebSocket bridge
│   ├── protocol.ts            # WebSocket message type definitions
│   └── ui-context.ts          # Extension UI bridge for web
├── commands/
│   └── web.ts                 # /supi:web slash command
web/
├── index.html
├── vite.config.ts
├── package.json
├── tsconfig.json
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── hooks/
│   │   └── useSession.ts
│   ├── components/
│   │   ├── Header.tsx
│   │   ├── Chat/
│   │   │   ├── MessageList.tsx
│   │   │   ├── UserMessage.tsx
│   │   │   ├── AssistantMessage.tsx
│   │   │   ├── ToolExecutionCard.tsx
│   │   │   ├── ExtensionUIDialog.tsx
│   │   │   └── InputBox.tsx
│   │   ├── Controls/
│   │   │   ├── ModelSelector.tsx
│   │   │   └── ThinkingToggle.tsx
│   │   └── Dashboard/
│   │       ├── TodoList.tsx
│   │       ├── SessionStats.tsx
│   │       └── ContextUsage.tsx
│   ├── types.ts               # Frontend protocol types (mirror of protocol.ts)
│   └── styles/
│       └── globals.css
```

## Error Handling

- **Server startup failure**: Command notifies user with error, cleans up PID file
- **WebSocket disconnect**: Frontend shows reconnection indicator, auto-reconnects (3 attempts, exponential backoff)
- **Session creation failure**: Server sends `{ type: "error" }` event, frontend shows error banner
- **Model switch failure**: Server sends error, frontend reverts selector to current model
- **Tool UI timeout**: UI context resolves with default value after timeout, frontend dismisses dialog

## Security

- Localhost-only binding by default (`127.0.0.1`)
- No authentication required for localhost (same trust model as the existing visual companion)
- Server rejects connections from non-localhost origins (CORS check)

## Testing Strategy

- `tests/web/protocol.test.ts` — Protocol type validation
- `tests/web/session-bridge.test.ts` — Event translation, command dispatch (mock AgentSession)
- `tests/web/ui-context.test.ts` — Extension UI request/response bridge
- `tests/commands/web.test.ts` — Command lifecycle (spawn, poll, stop)
- Frontend: No unit tests initially — manual verification via `bun run dev:web`

## Concurrency: Multiple Browser Tabs

The server accepts a single active WebSocket connection at a time. If a second tab connects:
1. The new connection receives the current `state` snapshot and full message history
2. The previous connection receives a `{ type: "error", message: "Session taken over by another client" }` and is closed
3. The new client becomes the active controller

This is the simplest correct behavior — multiple tabs controlling the same agent session would race on `prompt()` and `extension_ui_response`. "Last writer wins" with explicit takeover notification.

## Out of Scope (Future)

- Multiple simultaneous sessions
- Session history / session switching in the web UI
- File editor integration
- Diff viewer for tool edits
- Mobile-responsive layout
- Authentication for remote access
- Image rendering in messages