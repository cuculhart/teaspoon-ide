# Changelog

All notable changes to Teaspoon IDE are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-10-08

### Security

- File-system and Git IPC handlers are now confined server-side (in the
  main process) to directories the user has implicitly authorized,
  instead of trusting renderer-supplied paths. The main process keeps a
  set of "allowed roots" that is populated only by paths carrying user
  consent - a folder chosen through the native picker, a folder passed on
  the command line or dropped on the executable, a folder the app just
  created or cloned into - plus an explicit `register-project-root` call
  the renderer makes when it opens a project without a dialog (recent
  list, drag-and-drop onto the window).
- `read-file`, `write-file`, `delete-file`, `search-files`,
  `find-files`, `watch-project`, `open-path`, `terminal-run`, and all
  `git-*` handlers now reject paths outside the allowed roots.
  `create-directory`, `read-directory`, and `git-clone` additionally
  accept a brand-new directory directly under an allowed root or the
  user's Documents folder, so the create-project flows still work.
- What this prevents: a malformed or injected AI command that slips past
  the renderer's project-root check (`resolveFilePath`) can no longer
  read or write arbitrary files - e.g. `WRITE_FILE` to a startup folder
  or `READ_FILE` on a private key now fails in the main process. Search
  and watch requests can no longer enumerate arbitrary directories by
  passing a fake `rootPath` (which `delete-file` previously trusted
  unchecked), and terminal/git operations are likewise pinned to opened
  project folders.
- Scope note: this is defense-in-depth, not a sandbox boundary - a fully
  compromised renderer could still call `register-project-root` itself.
  Renderer-side XSS remains mitigated by DOMPurify-sanitized markdown.

### Fixed

- A dangling `// WRITE_FILE:` / `// EDIT_FILE:` opener (e.g. a response
  cut off mid-block by a timeout) is now reported to the model even when
  other files in the same response were written successfully. Previously
  the malformed-block check only fired when no write parsed at all, so a
  truncated third file was silently dropped and the model could claim it
  had been written. The retry feedback also now includes the target path
  and the last lines the model managed to emit, so it can resume the file
  faithfully instead of rewriting it from memory and silently dropping
  not-yet-emitted functions.
- The model can no longer end a turn by deferring remaining work to a
  "next response" and asking the user to say "continue" - the deferral
  is detected and the agent loop continues automatically instead.
- Opening the app in a browser (`RUN_COMMAND` that opens a file) while a
  file edit or run failure is still unresolved now continues the agent
  loop so the outstanding work is fixed first, instead of leaving the
  user with an incomplete build and a surprise edit approval afterwards.
- The agent no longer launches the result (browser opener / app start)
  on its own initiative after creating files; the system prompt now
  requires an explicit user request to run, open, or preview something.
  Users may still be planning follow-up work, and opening a
  half-finished app was confusing.

## [1.0.0] - 2026-10-05

### Added

- Six new color themes, selectable under Settings > Appearance >
  Theme: Violet Fizz (`fizz`, dark), Otegami (`otegami`, light washi
  paper with vermilion accents), Soda Float (`float`, light sky-blue
  soda), Modern Syntax eXtensible (`msx`, dark saturated blue screen
  with white text and bright palette colors), Chaya (`chaya`, dark
  tea-field green), and Coquette (`coquette`, light blush pink). Each
  ships with a matching Monaco editor theme; Otegami, Soda Float, and
  Coquette report as light themes to the OS chrome.
- The application menu, the right-click context menu, and native
  dialogs (folder picker, HTML/PDF export save dialogs) now follow the
  UI language instead of always being English. The selected language
  lives in the renderer's localStorage, which the main process cannot
  read, so the renderer pushes it over a new `set-language` IPC; the
  main process keeps its own copy of the `lang/<code>.json` dictionary
  and rebuilds the menu whenever the language changes. Menus appear in
  English for the brief window before the renderer reports the saved
  language at startup.
- Settings dialog sections are now grouped into collapsible panels
  (Appearance, AI Context, LLM Provider, LLM Proxy, History), so the
  growing list of options no longer scrolls as one flat page. The
  Gemini API key and model selection live under LLM Provider, and the
  LiteLLM proxy and organization sign-in under LLM Proxy. Collapsed
  state is remembered across restarts; LLM Proxy and History start
  collapsed.

### Fixed

- Clear API Key in Settings now asks for a second click (Confirm /
  Cancel), matching the existing two-step confirm on Clear All Chat
  History. It also no longer wipes the model selection, custom model
  name, and proxy URL along with the key - those are user preferences
  the owner can change back, so only the secret is removed.
- Filled out `lang/ja.json` (~90 keys) and routed the remaining
  hardcoded English through `t()`, so a Japanese UI no longer shows
  English in: the File/Edit/View/Window/Help menus and their items
  (Cut/Copy/Paste, zoom, fullscreen, ...), IPC error strings (invalid
  remote/branch/config names, "process not found", "path outside the
  project root", ...), Gemini/Ollama/organization sign-in error
  messages, the Settings model dropdown labels and proxy example line,
  the terminal "Stop" button, the rollback notice, the "Current model"
  tooltip, the user/assistant role labels on chat messages, the
  path-rejection reasons shown in chat notes, and the About dialog's
  "Version" label.

## [0.9.1] - 2026-10-04

### Added

- `// CLOSE_PROJECT` command: the AI can now close the open project
  when asked (e.g. "close the project"), routing through the same
  cleanup as File > Close Project. Reversible and non-destructive,
  so it runs without an approval dialog; commands emitted after it
  in the same reply fail cleanly. Previously the model had no way to
  close a project and would reply as if it had.
- New Project now warns when the chosen target folder already exists
  and is not empty. Because directory creation is recursive, such a
  folder was previously adopted silently as the project - mixing new
  files into an existing directory and binding the conversation to a
  path another project already used. The dialog now shows the item
  count and requires a second "Open Anyway" click to adopt it;
  changing the name or parent resets the warning.

### Changed

- The command parser moved from Chat.tsx to services/commandParser.ts so
  it runs under plain node; `npm run test:parser` exercises it against
  every malformed model output seen in the wild (URL truncation, glued
  commands, JSON blobs, bare commands, fenced examples, CJK prose).

### Fixed

- Commands typed without the "//" prefix ("WRITE_FILE: x.md" as a bare
  line) were previously invisible to the parser - nothing ran and no
  retry fired. Bare WRITE_FILE/EDIT_FILE headings (body to the next END
  terminator or end of reply) and bare single-line commands now execute;
  the colon after the keyword is required so prose doesn't match. The
  prompt now notes that the "//" prefix is required.
- Weak models sometimes emit commands as JSON blobs
  ([{"command": "WRITE_FILE", ...}]) instead of the // syntax; they used to
  sit in the reply as inert text. Objects that JSON.parse cleanly are now
  executed like real commands (common field names - path/file/cmd/target/
  content - are mapped), while blobs inside markdown fences or malformed
  JSON stay inert. The system prompt now also states that JSON is not a
  valid command format.
- `// RUN_COMMAND: start https://...` (open a URL in the browser) always
  failed: the command argument was cut at the `//` inside the URL, so
  only `start https:` survived - the approval dialog showed that
  truncated prefix and the open attempt then failed. Command arguments
  now end only before whitespace + `//` or a `//` command keyword,
  keeping URLs and UNC paths intact; `start`/`open`/`xdg-open` targets
  given as a markdown link (`[label](url)`) now resolve to the real URL.
- File commands whose path ran into the reply's next sentence with no
  separator ("// READ_FILE: .../Spec.md<glued prose> ...") tried to open
  the whole line as a filename and failed with ENOENT; the argument is
  now cut at the ".ext" boundary when non-ASCII prose is glued on
  (real CJK directory names are kept).
- Command syntax shown for documentation now stays inert. Examples the
  model wrote inside markdown code fences used to execute like real
  commands - asking "what commands can you use" made
  READ_FILE/WRITE_FILE run on template paths and even closed the open
  project via a CLOSE_PROJECT example. Lines inside ``` fences are now
  left as visible text, and the prompt tells the model to fence
  examples. Template-looking "<file_path>" args are deliberately treated
  as real attempts, so they reach the create-project prompt or a
  visible error instead of being silently ignored.
- Closing a project no longer disrupts the chat. Both the new
  CLOSE_PROJECT command and File > Close Project previously remounted
  the Chat panel: an in-flight agent loop was orphaned (its final
  reply was lost), the visible conversation was replaced by an older
  project-less one, and a leftover project-bound conversation could
  reopen its project when picked from the rail. The project now closes
  around the running chat, the editor releases the open file via the
  shared project-opened event, and the current conversation stays
  visible.
- A conversation keeps its project binding when the project closes
  mid-chat (previously the next save rebound it to "no project"), so
  reopening the project restores that conversation instead of
  starting empty. Chats continued with no project open still mark
  themselves as the conversation to show in that state.
- Reloading the app with a project open could show the wrong
  conversation: Chat's mount-time load ran before the Explorer's async
  project restore finished, saw "no project", and loaded the last
  project-less chat instead of the project's one. It now waits for the
  restore when a last-project path is configured. A stale
  "last project-less conversation" pointer is also cleared once its
  conversation gets bound to a project, so it can no longer hijack the
  startup load.
- Markdown tables in assistant chat messages could overflow the message
  bubble and trigger a horizontal scrollbar in the chat pane. Tables now
  always fit the bubble width (cell text, including long file paths,
  wraps as needed), and the message list no longer scrolls horizontally.
- Command result notes (Read file, Wrote file, Listed files, ...)
  showed the absolute path; they now show the project-relative path,
  so the OS user name no longer appears in chat history or gets echoed
  back to cloud providers.
- The chat header could push its action buttons (Rollback, Clear,
  focus toggle, Settings) off the right edge on narrow panes whenever
  the title side grew - a long model name, the budget badge, or the
  Rollback button appearing. The title/badges now shrink with an
  ellipsis while the buttons stay fully visible.

## [0.9.0] - 2026-10-03

### Added

- Chat focus mode: a toggle button in the chat header (or View > Toggle
  Chat Focus, Ctrl+Shift+B) hides the sidebar, editor, and terminal so
  the chat fills the window. The panes stay mounted and their widths are
  remembered; menu actions that need them (Open Project, Quick Open,
  Terminal, exports, ...) bring them back automatically. The mode is
  remembered across restarts.
- Conversation list in chat focus: a rail beside the chat shows all
  saved conversations with title, project badge, and timestamp, like
  hosted chat apps. Entries load in place (opening the bound project,
  or clearing it for project-less chats), can be deleted, and
  "+ New chat" starts a fresh conversation.
- Project-less conversations are persisted too: chats started with no
  folder open are saved and the last one is restored on the next run.
- Create-project prompt: when the AI wants to write a file while no
  project is open, a dialog offers to create a project folder (default
  parent: Documents) instead of rejecting the write. The new folder
  opens in place without remounting the chat, so the pending operation
  continues to the normal approval step. Offered at most once per user
  turn.
- Long-conversation compaction: chats longer than the recent window
  (20 messages) send older turns as a rolling summary instead of the
  full transcript, keeping requests within small-model context limits.
  The extra summarization call can be disabled in Settings > AI
  Context to keep request counts identical to before.
- New theme **Rich Wine** (`wine`): a bar-lit wine palette - red-tinted
  near-black surfaces, silvery text and type (the cocktail spoon),
  copper-orange keywords, amber/champagne strings and numbers, and
  mauve functions, so no code color reads as an error.
- Adversarial E2E suite (e2e/run.mjs, "npm run test:e2e"): launches
  the real app under Playwright's Electron support with a private
  --user-data-dir and stubs the Gemini endpoint via page.route(), so
  scripted model output exercises the command parser, file-access
  guards, approval dialogs, conversation storage, and markdown
  sanitization deterministically - no API key or network needed.

### Changed

- Assistant chat messages now render as Markdown (headings, lists,
  tables, code blocks) using the same marked + DOMPurify pipeline as
  the editor's .md preview. User messages and the streaming bubble
  stay plain text.
- Chat history moved from localStorage to JSON files under
  userData/chat-history (one file per conversation plus an index),
  with atomic writes and an automatic one-time migration - the ~5MB
  quota no longer caps growth, rawContent blobs (raw model output incl.
  file bodies) are trimmed from older messages before saving, and
  exhausted saves can no longer be silently dropped.

### Fixed

- Security: file commands are now rejected unless they resolve inside
  an open project. With no project open, absolute paths used to pass
  through, so a bare "// READ_FILE: C:/..." could silently read any
  file on disk and send its contents to the model; ".." segments were
  not normalized, so "../../x" escaped the project root as a string
  that only looked root-relative; and reads/lists fell back to the
  raw command argument on resolution failure, which let a rejected
  relative path read relative to the app's working directory.
- File commands emitted with markdown ":::" fences
  (:::WRITE_FILE: path ... :::) are now parsed as commands instead of
  shown as raw text - gemini-lite-class models emit that dialect
  reliably, so writes and the create-project prompt previously never
  fired.
- The current user message is no longer sent twice per request (once
  in the history array, once as the prompt).
- The model can no longer mistake a truncated history for the start
  of the conversation: when earlier turns are dropped by the
  recent-message window, the prompt discloses it (or attributes them
  to the summary), so questions like "answer my first question" get
  an honest answer instead of the first visible turn.
- The app-context prompt now describes the app accurately - chat
  focus, supported platforms (Windows/macOS/Linux), the built-in
  providers (Gemini API / Ollama / LiteLLM proxy), and the text-tab
  sidebar - so the model no longer invents UI elements, platforms, or
  providers; a UI-state note covers "I can't see the sidebar" while
  chat focus is on.
- The no-project prompt now matches actual behavior: WRITE_FILE and
  EDIT_FILE trigger the create-project dialog rather than failing,
  bare "create a project" requests are sent there directly via a
  starter file, the manual path (File > New Project... / the
  Explorer's New Project button) is named as the fallback, and the
  model is told not to repeat the "no project is open" note in every
  reply.

## [0.8.0] - 2026-10-03

### Fixed

- Command failures are no longer fed back to the model as bare exit
  codes: RUN_COMMAND results now carry the output tail and an
  interpretation hint that distinguishes test-runner failures,
  command-not-found errors, and other non-zero exits. The system prompt
  tells the model that a non-zero exit is a result to read, not proof of
  a broken environment, and after three consecutive failed commands the
  feedback tells it to stop probing alternate interpreters/PATHs - the
  model previously burned ~30 steps hunting for Python installs after
  misreading a failing test as an environment problem.
- Tests that were already failing before the agent's first edit are now
  reported as pre-existing failures rather than regressions, and the
  prompt tells the model to say so and finish instead of trying to fix
  unrelated failures.
- A failed WRITE_FILE/EDIT_FILE can no longer be silently abandoned: it
  stays flagged as unresolved until a later write/edit succeeds (a
  passing test run no longer clears the flag), every continuation
  message reminds the model that the target file is still unchanged on
  disk, and the end-of-turn nudge names the failed operation and the
  last failing command's output. If the model declares completion anyway
  without ever applying the change, a warning is appended telling the
  user the reported changes may not exist on disk - previously a failed
  edit followed by a passing narrow test could produce a confident but
  false "refactoring complete" report.
- Terminal panel: finished command blocks now auto-collapse to a
  one-line status row (icon, command, exit code) while the running
  process stays expanded, so earlier failed commands no longer dominate
  the view after a task ultimately succeeds. Completed headers are
  clickable to expand/collapse their output; Clear still removes all
  finished blocks.
- The terminal input placeholder no longer shows `npm install`, which
  looked like an already-entered or suggested command - it now reads
  "Type a command...".
- Open Project dialog: the action row (Select Folder / Clone Repository
  / New Project / Cancel) now wraps instead of overflowing the
  fixed-width dialog and overlapping the content below, which happened
  whenever the combined button width exceeded the dialog - depending on
  UI language and font metrics.

## [0.7.0] - 2026-10-01

### Changed

- The "Quiet Light" theme is renamed "Organic Light" - the palette is
  a muted warm-paper variant of our own rather than a port of VS Code's
  Quiet Light, so it gets its own name. The stored setting value stays
  `quiet`, so existing selections keep working.

### Added

- Four new themes (Settings > Theme): **Muted Ocean** (deep-sea blue,
  Night Owl-inspired but with reduced text luminance), **Ancient
  Console** (eye-friendly green-phosphor CRT homage with the editor pane
  as the brightest surface), **Walnut** (dark wood with cool silvery
  "new nail" text), and **Heritage** (pale woodgrain with reddish-black
  groove text, echoing beige-box PCs). Each theme ships with a matching
  Monaco editor palette; the internal ids are `ocean`, `console`,
  `walnut`, and `heritage`.
- Post-edit test verification is now part of the agent's standard
  procedure: when the project has a test suite (a `tests/` directory,
  `test_*.py` files, a `test` script in package.json, etc.), the prompt
  requires running it via RUN_COMMAND after edits and fixing regressions
  before the final answer. It also reminds the model to keep public
  signatures and semantics intact when the user asks for
  behavior-preserving changes.

### Fixed

- White text on `--accent` backgrounds is no longer hardcoded: a new
  `--on-accent` variable sets the label color per theme, so themes with
  light accents (Muted Ocean's gold, Ancient Console's green, Walnut's
  brass) now render near-black ink text on user chat bubbles, send and
  submit buttons, and dialogs - previously white on gold was barely
  readable.
- `EDIT_FILE` parsing is far more tolerant of small-model output:
  delimiter runs of the wrong length (`<<<`/`>>>>` instead of seven),
  missing `SEARCH`/`REPLACE` words, and diff blocks wrapped in markdown
  fences are all accepted instead of rejected. An `EDIT_FILE` opener that
  was never closed with `// END_EDIT_FILE` is now salvaged when the body
  already ends with a complete `>>>>>>> REPLACE` delimiter - previously
  the block was dropped and the model burned a step re-emitting it.
- `WRITE_FILE` bodies that contain SEARCH/REPLACE diff markers are
  rejected before touching the disk (the markers would be written
  literally, producing a broken file). The model is told to re-emit the
  raw file content instead.
- Repeated edit failures now escalate: the error feedback includes a
  complete minimal `EDIT_FILE` example, and after two consecutive
  failures the model is told to stop retrying diff syntax and emit a
  `WRITE_FILE` with the full file content instead.
- The agent loop no longer lets a turn end on an unresolved failure: if
  the model gives its final answer while an earlier command or edit in
  the same session failed (e.g. tests still red), it gets one explicit
  nudge to either fix the failure or state why it is unrelated.
- The continuation prompt now reports the remaining step budget
  (`Step N of 6`) and tells the model to reply with a plain final answer
  once the work is done - small models kept re-verifying finished work
  until the step budget ran out.

## [0.6.0] - 2026-09-29

### Changed

- Renamed the project from **Forger** to **Teaspoon IDE** (package and
  repository `forger-ide` → `teaspoon-ide`) to avoid confusion with the many
  similarly named Forge/Forger projects. The name reflects the design goal:
  getting real work done on a teaspoon of tokens.

### Added

- Explorer file watching: the main process watches the open project
  folder (`fs.watch` recursive on Windows/macOS, per-directory watchers
  elsewhere) and the Explorer tree reloads automatically when files or
  folders are added, deleted, or renamed outside the app - external
  editors, Windows Explorer, terminal commands, `git checkout`, etc.
  Events are debounced, expanded folders stay expanded, and changes
  inside ignored directories (`node_modules`, `.git`, `dist`, ...) are
  not reported, matching the project-search ignore policy. The Git
  panel refreshes its status on the same signal, so external git
  operations are reflected without a manual refresh. A refresh button
  (⟳) in the Explorer header triggers a manual reload as well.

## [0.5.0] - 2026-09-26

### Added

- **Organization (managed) mode** for centrally managed deployments: enabling
  "Require organization sign-in" in Settings locks the app behind a sign-in
  gate until the user authenticates against the organization server. The
  server issues a per-user virtual API key that talks to an LLM proxy
  (e.g. LiteLLM), so real provider keys never leave the server. "Continue
  without an organization" switches back to local/personal use at any time.
- Organization-controlled model selection: the sign-in response carries the
  list of models the issued key may use; the Organization section shows a
  restricted model dropdown and the personal Model Selection is locked while
  a managed session is active.
- Budget indicator in the chat header: the remaining allotted budget is shown
  as a percentage (e.g. `99.9%`) - never a currency amount - next to the
  model badge while signed in to an organization. It warns below 20% and
  turns red at 0%, refreshes after each response and every 60 seconds, and
  its tooltip shows the reset date.
- Managed-mode error messages: a spent personal budget, an exhausted
  organization-wide provider quota, a rate limit, and a model that is not
  permitted by the organization each produce a clear localized message
  instead of raw proxy/provider errors.

### Changed

- In managed mode the provider/model fallback is disabled: the organization
  controls the model list and the fallback no longer rewrites the personal
  model setting.

### Fixed

- Clearing the API key in Settings now notifies the chat immediately, so the
  configured/unconfigured state updates without a restart.

## [0.4.0] - 2026-09-26

### Added

- Open the current project's root folder in the OS file manager from the
  Explorer header (↗) or File > Open Project Folder. Uses Electron's
  shell integration, so no per-OS or per-distro command is needed.
- Git setup dialogs: clone a repository from the Open Project dialog or
  into an empty open project folder, add or update remotes, create the
  initial commit, push a branch with upstream tracking, and configure
  `user.name` / `user.email` globally or for the current repository. The
  toolbar Push action also configures upstream automatically when the
  target remote is unambiguous.

### Fixed

- Terminal output and chat messages now stay pinned to the bottom while the
  user is already there. Scrolling up pauses auto-follow (so history can be
  read without being yanked down); sending a message or opening the panel
  resumes it. Terminal's default height was raised, its scroll body can
  shrink correctly, and its header/input rows no longer collapse when space
  is tight. The editor is also explicitly relaid out when the terminal is
  shown or resized, and editor overflow is clipped at the pane boundary,
  fixing the first-show header clipping that previously needed a manual
  pane resize.
- Browser-open RUN_COMMAND approval no longer shows or runs prose glued to
  the target by small models (for example
  `xdg-open start index.html[result message]`); recognizable opener
  commands are normalized to the host opener plus URL/file target, while
  unrelated shell commands are left unchanged.

## [0.3.2] - 2026-09-25

### Added

- Chat history controls: clear the current project's conversation from the
  Chat header, or delete saved conversations for every project from
  Settings. Both destructive actions require confirmation; clearing all
  histories also immediately resets the open Chat panel.

### Fixed

- Clearing all chat history no longer uses Electron's synchronous native
  confirmation dialog, which left Settings controls unresponsive after it
  closed. Destructive chat clears now use inline Confirm/Cancel controls.
- Editor undo/redo (Edit menu and Ctrl+Z/Ctrl+Shift+Z) did nothing: when
  the menu opened the editor lost text focus, so the handler fell back to
  the native (DOM) undo, which cannot reach Monaco's undo stack. The
  handler now calls `model.undo()/redo()` on the open file's model unless
  focus is in another editable element.
- AI file writes that wrapped the whole file in a markdown code fence
  ("```md ... ```") are unwrapped before writing - the fence was being
  saved literally, breaking markdown preview.
- WRITE_FILE blocks where a small model used the closing "```" of a
  wrapped body as the terminator (instead of "// END_WRITE_FILE") are now
  salvaged instead of looping on "incomplete block" retries.
- File-path arguments like "README.md (assuming you meant ...)" - prose
  parentheses appended by small models - are cleaned before use, so they
  no longer produce ENOENT reads of garbage filenames.
- Command-like lines inside WRITE_FILE/EDIT_FILE bodies (e.g. a README's
  own "// RUN_COMMAND:" example) are file content, not commands - they no
  longer execute or trip the malformed/unknown-command checks.
- The "code shown but not written" retry now fires for any response that
  contains a code fence (previously only when the whole reply was one
  fence) - models dodged the check by adding prose around the snippet.
- Explorer empty state: the Recent Projects list items inherited the
  accent-background button style, making them unreadable (dark text on
  teal, worst in Quiet Light). The rule now targets only the direct
  Open/New Project buttons.

### Changed

- Each open file now gets its own Monaco model (`path` + `keepCurrentModel`),
  so undo history and cursor position survive markdown preview toggles
  and file switches instead of being reset.
- Privacy: the LLM no longer sees absolute paths. Project context
  (file tree, selected/full-file contents) and command feedback
  (READ_FILE/LIST_FILES/WRITE_FILE/EDIT_FILE results, RUN_COMMAND output)
  use project-relative paths - previously `C:\Users\<name>\...` leaked
  the OS user name to cloud providers.
- The system prompt now names the host OS's browser opener directly
  (`// RUN_COMMAND: xdg-open <target>` on Linux, `start`/`open`
  elsewhere) instead of showing a three-OS table - small models were
  listing the manual steps for every OS instead of emitting the command.

## [0.3.1] - 2026-09-25

### Added

- Right-click context menu (undo/redo/cut/copy/paste/select-all in
  editable fields, copy/select-all on selected text) - Electron ships no
  built-in one, so chat text could not be copied on Linux/Windows.
- README: `git clone` and Node.js v22 install via `n`/`nvm` documented in
  Getting Started (English and Japanese).

### Fixed

- Settings: the Save/Clear buttons only apply to Gemini settings and are
  now hidden when the provider is Ollama - everything Ollama-side applies
  on change, so they blocked saving for no reason.
- "Clear API Key" no longer wipes unrelated settings (theme, provider,
  Ollama endpoint/model) - it deleted the entire in-memory config.
- `// END_READ_FILE`-style invented terminators no longer trigger the
  "unknown command" retry; only invented openers do.
- Two more small-model misfires now trigger a corrective retry instead of
  ending the turn: a file-creation request answered with only a markdown
  code fence (never written to disk), and the model parroting the app's
  own "Command execution results:" wrapper as its reply.

## [0.3.0] - 2026-09-24

### Added

- Cross-platform "open in browser": the agent prompt now documents the
  per-OS opener (`start` / `open` / `xdg-open`), and `RUN_COMMAND`
  intercepts all three plus `cmd /c start`, routing them through Electron's
  `shell.openPath` / `shell.openExternal` on every platform.
- Application icon (`assets/icon.ico` multi-size, `assets/icon.png`,
  transparent background): applied to the packaged exe, the Squirrel
  installer (`setupIcon`), the Add/Remove Programs entry (`iconUrl`), the
  Linux window/deb icon, and the About dialog.
- "Quiet Light" theme: a muted warm-paper light theme for users who find
  pure white backgrounds glaring. Covers the full UI (CSS variables),
  Monaco (`forger-quiet` editor theme), and the terminal, selectable via
  Settings > Theme.

### Changed

- About dialog: the tagline is now the brand slogan "Standalone,
  Privacy-First AI IDE", the app icon is shown, and the app name uses the
  brand gold (`#f1af10`; darker amber on light themes).
- Agent prompt: explicitly requires emitting `// WRITE_FILE:` when asked
  to create a file (never a bare markdown code fence), using the exact
  file name the user asked for (no renames, extension changes, or
  subdirectory moves), the correct block terminator, and only
  opening/running files that already exist. Fixes small local models (e.g. qwen2.5-coder:1.5b) rewriting
  "index.html" into "routes/TestIndex.tsx" and opening files before
  creating them.
- Small Ollama models (<3B params, detected from the model tag) now use a
  compact system prompt (command protocol only, no app-context text) and
  only the last 8 history turns - long prompts and polluted history
  degrade instruction-following at that size.
- When no project is open, the model is told that file-operation and
  shell commands are unavailable and to ask the user to open a project
  first (both Ollama and Gemini), instead of receiving commands that all
  fail and hallucinating fake files and results on retry.

### Fixed

- A successful "open in browser" (`start`/`open`/`xdg-open`) no longer
  continues the agent loop: it produces no terminal output, and feeding
  "(no output)" back made small models read it as a failure - retrying,
  guessing the wrong OS, and fabricating results. The turn now ends with
  a success note and closing summary. The host OS is also stated in the
  system prompt so models stop emitting Linux commands on Windows.
- Invented commands (e.g. "// CREATE_INDEX.HTML") are detected and
  reported back to the model with the list of valid commands so it can
  retry, instead of being shown as raw text that ends the turn.
- `start`/`open`/`xdg-open` no longer chokes on trailing prose: the
  prompt example itself showed "(or start http://localhost:3000)" inside
  the command, which small models copy verbatim. The example was fixed
  and unquoted trailing parenthetical text is stripped from the target.
- Writes into a subdirectory the user never asked for are rejected before
  touching the disk: when the request names a bare file (e.g.
  "index.html") but the model targets "views/index.html", the write is
  refused and the model is told to emit it at the project root instead.
- Malformed file-command blocks are handled more gracefully: commands
  without a colon (`// READ_FILE file.js`) and blocks closed with another
  language's comment marker (`# END_WRITE_FILE`) now parse correctly; a
  `// WRITE_FILE` / `// EDIT_FILE` opener that still cannot be parsed is
  reported back to the model (naming the correct terminator) so it can
  re-emit a complete block, and the chat shows a retry note instead of
  raw command text.

## [0.2.0] - 2026-09-23

### Fixed

- `RUN_COMMAND start <target>` (open in browser) now launches the app
  reliably: `start` inside a transient ConPTY `cmd` could exit before the
  browser appeared. File/URL targets are opened via Electron's
  `shell.openPath` / `shell.openExternal` instead, confined to the project
  root for files.
- Small local models no longer imitate "▶️ Ran: ..." execution notes: chat
  history sent to the model now uses the raw response, so display notes
  (including notes saved in older chats) can no longer leak into the context
  and be parroted back as fake results.
- Switching provider/model in Settings mid-generation no longer retargets
  the in-flight request: the provider and model are pinned when Send is
  pressed, so every agent-loop step (and the model label) of one turn always
  uses the model that was selected at send time.

### Added

- Response time display: each assistant message now shows the LLM call's
  round-trip time (e.g. `(6.1s)`). In multi-step agent runs each turn shows
  its own turnaround, which makes comparing local model speeds easy.
- Streaming responses for the Ollama provider: replies appear token-by-token
  like AnythingLLM/Ollama CLI, so slow local models feel alive instead of
  sitting on "Generating response..." for a minute. Cancelling now actually
  aborts the in-flight HTTP request. (Gemini path unchanged.)
- Per-message model label: assistant messages show the model that produced
  them (e.g. `assistant (ollama:qwen3.5:4b)`), so switching models mid-chat
  stays verifiable.

## [0.1.1] - 2026-09-23

### Fixed

- AI agent now knows how to open files/URLs in the user's browser: the system
  prompt explains that `// RUN_COMMAND: start <target>` opens the default
  browser on Windows. Previously, small local models (e.g. `gemma4:e4b`) did not
  emit a command when asked to "open it in my browser".

## [0.1.0] - 2026-09-22

Initial public release.

### Added

- Standalone Electron AI editor: file explorer, Monaco editor, Git, real TTY
  terminal, and AI chat in a single window
- Agent loop with approval dialogs: WRITE_FILE / EDIT_FILE (diff edits) /
  READ_FILE / LIST_FILES / GREP / FIND_FILES / RUN_COMMAND
- Checkpoint & rollback for AI-touched files
- Gemini API (BYOK) and Ollama (fully offline) providers; LiteLLM proxy support
- File-tree-only context mode for token efficiency
- English/Japanese UI via `lang/<code>.json` localization
- Windows packaging (portable exe / Squirrel installer)
