# Noda note library and storage

The note list updates automatically, including after external file changes. The menu beside search selects filters and sort order without a separate refresh button. On wide windows, the arrow beside the current project opens the project list; on narrow windows it opens the project panel. Escape closes the nested menu first, then closes the project selection and returns focus to its button.

Manual note creation preserves the spaces, indentation and line breaks entered in Markdown. Noda can add the title and selected tags as separate lines when needed.

Creating, editing and restoring notes also works without the semantic search model. The file and local list are saved independently of vector computation. If that model is disabled or unavailable, the semantic index remains unavailable, text search continues to work, and no fake vectors are created.

## Editing and save behavior

Notes open in formatted preview by default, including existing Obsidian Markdown.
The eye button switches to source editing; its tooltip names the next action.
Formatting controls insert Markdown while editing. Refreshing the same open note
preserves the selected mode; opening another note starts in preview again.
Local drafts are shown in preview and retained when switching modes.
The filename, tags and supported properties at the beginning of the file are preserved.

By default, text is saved after a one-second pause and when leaving the field. Settings can change the delay from 0.5 to 10 seconds, disable autosave, or adjust font size and interface density. Manual mode provides a Save button and Ctrl + S. Local drafts continue to be retained. The editor footer shows save status; Ctrl + S saves or retries after a failure.

If another editor changes the file, Noda does not overwrite that revision. It offers to save the edits separately or load the current file. Reloading requires confirmation. The draft is removed only after the fresh file loads successfully. After an uncertain write result, retry first checks the file.

Drafts are kept locally in the app profile, separated by project and note. Opening a note restores its draft; New note restores the separate creation draft. If local storage is unavailable, the interface warns that the draft will survive only until the window closes.

## Trash and restoration

The open note's **… → Move to trash** action moves the file into `.noda-trash` inside the project. The project's trash can restore it. If another file has appeared at the original path, Noda leaves both files where they are; free that path before restoring.

A full project backup must include `.noda-trash` if restoration history is needed. The separate note-copy export intentionally excludes trash and other runtime data; see the [user guide](USER_GUIDE.md#data-and-backups).

## Search and metadata

### Connected notes

The editor and Markdown preview show a **Connected notes** section below the body.
It uses the same saved connections as Graph, including links pointing back to the
current note. It resolves canonical filenames, displays note titles and hides the
section when no saved connections exist. Shared tags alone do not create a link.
Changes appear automatically; no model or semantic index is needed for this list.

Click a title, or focus it and press Enter, to open that note in the same project.
With autosave disabled, navigation retains the current draft without publishing it.
Unresolved links are not presented as available notes. A loading failure is shown
explicitly and retried during automatic library refresh.

In Notes chat, source buttons below an answer open the cited notes. The optional
excerpts disclose the retrieved source text. An answer without retrieved sources
does not invent source buttons or related notes.

Library search includes titles, tags and the full text of the active project's notes. Semantic retrieval in chat uses a separate index. If index updating is not confirmed, the interface shows a warning.

The pencil beside the title opens note properties: title and tags. It changes the displayed title while retaining the filename and links to it. Metadata is saved separately from the source text with a revision check.

The current text must be saved successfully before the properties dialog opens; an unresolved conflict cannot be bypassed. With autosave disabled, opening properties asks for an explicit text save and does not silently write the text. Cancelling deletion does not save the text either. Confirmed deletion remains blocked while manual edits are unsaved. Tags written directly in Markdown remain part of that text.

For a `faithful-v1` file, adding user tags moves the wrapper into the supported `ru-pipeline-v1` schema. The source text, its checksum and length stay unchanged. Earlier compatible builds can read that schema. Unknown valid properties are preserved; unsupported YAML structures are rejected.

The **Last 7 days** filter covers the preceding seven days and excludes future timestamps. Queue-entry removal is described in the [capture workflow](USER_GUIDE.md#capture-and-edit).
