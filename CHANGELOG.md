# Changelog

## 1.14.0

- **Feature**: a **Secrets** tab (bottom panel) keeps API keys and passwords as name → value pairs, outside the workspace and its git history. Automations read one with `getSecret('name')` (`hasSecret` checks); a changed value reaches running automations without a reload. The AI and MCP clients see the names only (`list_secrets`)
- **Feature**: published entities can have their own device: `this.publish.sensor(id, { device: 'e-bloc', ... })` puts the entity under an **e-bloc** device (linked to TAE) instead of the TAE device; entities with the same `device` name share it

## 1.13.1

- **Fix**: secret files stay out of the workspace's git history. 1.13.0 committed every file, so API keys kept in a workspace file ended up in the `/share/tae.git` mirror, which anyone with access to `/share` can read. Files named `*-secret.ts`, `*.secret.ts` or `secrets.ts` are now in `.gitignore`, and on start TAE removes any that are already in the history from every commit (authors, dates and messages stay) and prunes them from the mirror. The files themselves stay in the workspace

## 1.13.0

- **Feature**: tests check the data of a service call: `expect_service` takes `data` (the call's data must contain these values, nested objects too) and `count` (exactly this many calls). A mismatch says what the call sent instead
- **Feature**: entities an automation publishes (`this.publish.*`) are simulated states in tests, so `expect_state` can check them (with `attributes` that must match) and other automations see them change
- **Feature**: tests can restart TAE: a **Restart TAE** step stops the automations and loads them again; persistent storage, states and published entities stay, timers and temp storage are gone. A scenario's `storage` sets persistent storage per automation before the run (other automations get a copy of their real storage), to test what an automation does when it starts with something remembered
- **Feature**: the workspace is a git repository. On first start TAE commits it as it is; MCP clients and the AI chat review a piece of work across files with `workspace_changes`, commit it with a message (`commit_changes`, optionally only some files) and read the history (`workspace_log`). Commits are mirrored to a bare repository, by default `/share/tae.git` (option `git_mirror_path`; `none` = no mirror), so it can be cloned over SSH or Samba
- **Fix**: the API reference, README and JSDoc examples used the mired `color_temp`, which Home Assistant 2026.3 removed (it rejects such calls); they use `color_temp_kelvin` now, and the reference says so

## 1.12.1

- **Change**: publishing entities moved to `this.publish.sensor(...)` / `this.publish.binarySensor(...)`, so it can't collide with a `sensor` field of your own automations

## 1.12.0

- **Feature**: automations publish their own entities to Home Assistant: `this.publish.sensor(id, options).set(state, attributes)` and `this.publish.binarySensor(...)`, over MQTT discovery (needs the Mosquitto broker app). They appear under a **TAE** device and survive HA restarts
- **Feature**: TAE in Home Assistant: `sensor.tae_status` (running, version, automation counts) and a switch per automation that shows whether it runs and starts or stops it

## 1.11.0

- **Feature**: AI settings have an **Automations model** for `this.ai.generate`: the same as inline completions (default), the same as the chat, or a custom model. The dialog shows which model automations end up using
- **Change**: the model fields in AI settings suggest models in TAE's own dropdown (like the Tests panel) instead of the browser's: the provider's defaults right away, every model after **Load models**, filtered as you type

## 1.10.0

- **Feature**: **AI in automations**: `this.ai.generate(prompt, options?)` writes text with the provider and key from TAE's AI settings: spoken announcements, notification wording, summaries. Options: `system` (instructions), `model` (`"fast"` = completion model, default; `"smart"` = chat model), `maxTokens`, `timeoutMs`. Each request's model, tokens and cost go to the automation's log; an automation can make 30 requests per hour. Tests return a placeholder text, live test runs use the real AI
- **Feature**: `callService(domain, service, data, { returnResponse: true })` resolves with the service's response data, for services such as `weather.get_forecasts`, `calendar.get_events` and `todo.get_items`

## 1.9.4

- **Change**: AI chat edits show what they changed even after **Always allow**: the tool card has the diff and a "+N −M" line count in its header (approval requests show the count too), so a comment-only edit can be told apart from a logic change at a glance. Export includes it
- **Fix**: diffs of files with Windows line endings no longer carry stray carriage returns (blank lines in exported chats)

## 1.9.3

- **Feature**: **AI memory** (🧠 in the AI chat header): short notes the AI keeps across chats, such as what you call things ("sink light" = which entity), how rooms and devices are used, and preferences. The AI saves, changes and removes notes on its own (`remember`, `update_memory`, `forget`; no approval needed, each one shows in the chat), and you can add, edit and delete them in the panel or turn AI writing off. Notes go into every chat; MCP clients read them with `get_memory`
- **Feature**: the same panel sets how long chats are saved and how many, shows how many are saved, and can delete them all

## 1.9.2

- **Fix**: AI chats are saved, so an add-on restart or update no longer wipes what the AI remembers of the conversation (before, the chat still showed on screen but the AI only saw the next message). Chats are kept for 14 days (last 50). If the AI no longer has a chat's earlier messages, the chat says so
- **Fix**: `type_check` no longer reports imports ending in `.ts` as errors (TS5097); they run fine and the editor accepts them, so the AI kept "fixing" them
- **Fix**: `edit_file` matches multi-line edits in files with Windows line endings, and when old_string is not found it shows the closest text in the file, so the AI can copy it instead of guessing
- **Fix**: a chat message sent while TAE is disconnected (e.g. restarting) is no longer lost: it stays in the box with a note
- **Change**: the AI asks what you mean when a request refers to something it cannot find in the conversation, instead of guessing
- **Feature**: AI chat messages show their time, and **Export** downloads the chat as Markdown (messages, tool calls with input and results, approvals, times)
- **Change**: the chat's context line shows the open file's path

## 1.9.1

- **Feature**: tests can send their service calls to Home Assistant (**Send calls to Home Assistant**), so you can fake a trigger (sunset, motion) and watch the real devices react. **Waits take real time** makes waits last as long as they say. Such tests are tagged **HA**; the AI's `run_test` and **▶ This file** still run them simulated
- **Feature**: **■ Stop** ends a running test
- **Change**: entity, state and service fields in tests get a proper suggestion list (matches entity ids and friendly names, shows current states) instead of the browser's own
- **Change**: the AI chat sidebar and the test result pane can be resized by dragging their left edge (double-click resets)

## 1.9.0

- **Feature**: **Tests** tab: scenarios that set entity states, wait and fire events, then check states and service calls. They run in an isolated copy of the automations with a simulated clock (waits are instant) and recorded service calls (no device reacts). Scenarios are saved per file and keep their last result; the AI can list, write and run them (`list_tests`, `get_test`, `save_test`, `run_test`)
- **Feature**: **Timeline** tab: every run of every automation (state change, event, timer, onStart) with the service calls, logs and errors it caused and their timings; timers show what scheduled them. Also an AI tool (`get_automation_timeline`)
- **Feature**: **File history**: every save, AI edit, import, restore and delete is versioned (also changes made outside TAE). Compare any version with the file now or with the version before it, and restore it, including deleted files (`🕘 History`, AI tools `file_history`, `restore_file_version`)
- **Feature**: entity ids in the editor: autocomplete with friendly names, hover with state and attributes, and a warning with a quick fix for unknown ids (typos). `type_check` reports them too
- **Feature**: AI chat: `@file` and `@entity` mentions attach the file or entity state to the message; estimated cost per reply and per chat for Claude models
- **Change**: an error in a timer callback started by an automation now counts as that automation's error (⚠) instead of a worker error

## 1.8.1

- **Feature**: chat effort and inline completion effort in AI settings (Claude: `output_config.effort`; OpenAI-compatible: `reasoning_effort` where the model accepts it). A changed chat effort applies to new chats
- **Fix**: the chat's "Context:" line now follows the open file, and shows unsaved edits and the selection

## 1.8.0

- **Feature**: AI chat with tools - entity/area/service lookup, file read/edit with approval and diff preview, type-check, reload, logs, service calls - for every provider
- **Feature**: MCP server (port 3201, token protected) exposing the same tools to Claude Code and other MCP clients
- **Feature**: Anthropic through the official SDK with current models (`claude-opus-5-5`, `claude-haiku-5-5` for completions) and prompt caching; DeepSeek added to the docs; GitHub Models moved to its current endpoint
- **Feature**: AI settings saved in TAE persist across restarts; model list loaded from the provider
- **Fix**: an error in a subscription callback (e.g. a failed `callService`) no longer stops the automation permanently; it is logged and shown as ⚠
- **Fix**: standalone `getEntityState()` is synchronous as documented (it returned a Promise, so checks like `getEntityState(x)?.state === 'on'` were always false)
- **Fix**: the worker thread is restarted automatically if it dies
- **Fix**: `onReload()` is now called before a reload
- **Fix**: event subscriptions are released in Home Assistant on stop/reload; TAE subscribes to `state_changed` only instead of every event
- **Fix**: `fetchEntityState` fetches one entity instead of all states
- **Fix**: the UI only accepts connections through ingress; automation names and errors are escaped in the sidebar
- **Change**: Node.js 24 (base image 21.0.10); 32-bit platforms (armhf, armv7, i386) are no longer supported by the base image
- **Docs**: SKILL.md corrected (only `index.ts`'s `onInit()` runs; `emitAll`; error behaviour)

## 1.7.0

- **Feature**: AI integration — inline code completions and chat sidebar (GitHub Models, OpenAI, Anthropic)
- **Feature**: AI settings dialog for configuring provider, API key, and models from the UI
- **Feature**: Code snippets — define reusable templates in `.snippets` files with tab-stop placeholders
- **Feature**: Storage entries now open on single click (name or value)
- **Feature**: Tab drag-and-drop reorder in the editor
- **Feature**: `Ctrl+Shift+S` saves all open files
- **Feature**: Help panel (`Ctrl+Shift+H`) with keyboard shortcuts reference
- **Fix**: SKILL.md no longer auto-downloads on page load (only when the download button is clicked)
- **Fix**: Event subscription duplication on reload
- **Fix**: Session persistence for sidebar state and scroll positions
- **Fix**: Horizontal sidebar resize handle
- **UI**: Clear Logs button moved to output panel filter bar
- **Docs**: Added AI Integration setup guide with GitHub Models PAT instructions
- **Docs**: Added Code Snippets documentation

## 1.6.0

- **Feature**: Storage viewer in the sidebar — see all persistent (SQLite) and temporary (in-memory) key/value pairs in real time, grouped by namespace, with collapsible sections
- **Feature**: Resizable sidebar panels — drag the handles between Automations, Files, and Storage sections to adjust their height
- **Feature**: Auto-scroll toggle in the output panel — locks the log view to always show the latest entry; automatically disables when you scroll up
- **Feature**: Unsaved changes warning — the browser prompts for confirmation when navigating away with unsaved files
- **Fix**: Terminal `help` autocomplete no longer appends a `(` — help is a keyword, not a function call
- **UI**: Terminal placeholder changed to "Type 'help' for help"

## 1.5.0

- **Fix**: Terminal `callService` now correctly parses object arguments with string values (e.g., `{entity_id: 'light.x', brightness: 128}`)
- **Fix**: Terminal `callService` now sends `entity_id` via the HA `target` field for proper service targeting
- **Feature**: `help` command in terminal — `help` shows all commands, `help <command>` shows detailed help with examples
- **Feature**: Autocomplete for `help <command>` suggests available function names
- **Docs**: Added terminal usage documentation to README
- **Docs**: Added file saving behavior, Work with AI, and changelog sections to README

## 1.4.0

- **Fix**: SKILL.md download now works (file is copied into Docker image; server uses fallback paths)
- **Feature**: Terminal tab in bottom panel — interactive console for calling TAE functions (`callService`, `getEntityState`, `fetchEntityState`, `getAllEntities`)
- **Feature**: Context-aware autocomplete in terminal for domains, services (grouped by domain), entity IDs, and function names
- **Feature**: Reload button shows orange badge with unsaved file count
- **Feature**: Auto-save all modified files before reload
- **Feature**: Unsaved changes dialog when closing a modified tab (Save & Close / Discard / Cancel)
- **Feature**: Work with AI button — download entities list and SKILL.md for AI assistants

## 1.3.0

- **Feature**: Work with AI dialog with entities download and SKILL.md download
- **Fix**: `getEntityState` and `fetchEntityState` standalone exports
- **Feature**: YAML to TypeScript interface converter tool

## 1.2.0

- **Feature**: Drag-and-drop file/folder reordering in sidebar
- **Feature**: Folder creation and file renaming
- **Fix**: File tree refresh after operations

## 1.1.0

- **Feature**: Multi-tab editor with dirty state tracking
- **Feature**: Log level and source filtering
- **Feature**: Import/Export sync with `/share/tae`

## 1.0.0

- Initial release
- TypeScript automation runtime with worker thread isolation
- Monaco editor with IntelliSense
- HA WebSocket integration (services, events, state)
- SQLite persistent storage + in-memory temp storage
- Real-time log viewer
