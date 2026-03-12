# Changelog

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
