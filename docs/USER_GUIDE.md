# Noda user guide

Noda keeps each library in a local Markdown folder. The app adds editing, optional model processing, search, a graph and chat around those files.

## Create or connect a project

In **Notes**, use **+** beside Projects to create a project or connect an existing folder. Creating a project makes a new subfolder in the parent folder you choose. Connecting an existing folder leaves its files in place.

Select a project from the left panel or the arrow beside the library name. Project folders must not overlap or contain one another. Noda keeps note search, queues, chat history and drafts in the current project's context. Model installations, theme and interface language are shared app settings.

Use full Windows folder paths; abbreviated 8.3 paths, junctions and symbolic links are not supported for projects or backup destinations.

This is separation between local projects in one Windows account, not a system of access permissions between Windows users.

## Capture and edit

Press **Ctrl + Shift + Space** to open quick capture. Enter sends the source to the queue; Shift + Enter inserts a new line. Check the project shown under the input before sending.

The queue stores the submitted source before model processing. Its progress updates automatically. Expand an entry to inspect the source and stage results. Eligible waiting or completed entries can be removed; an executing entry is protected from deletion. Removing a completed queue entry does not delete its saved note.

If another note is edited, added or moved to trash during processing, Noda retries
against a fresh archive within the queue's existing attempt limit. It does not
publish links from the outdated snapshot or restore a deleted note. If the archive
keeps changing until that limit is reached, the exact source is saved as an
unprocessed note and remains available for a manual retry.

In the library, notes open in formatted Markdown preview. The eye button switches to source editing; its tooltip describes the next action. Formatting controls work while editing, and switching modes keeps the draft. Opening a different note starts in preview again. Use the title/tag control to change metadata; use the compact actions menu to move a note to the project's trash.

Saved **Connected notes** and backlinks appear below the note body. Open a connection by mouse or keyboard. Empty connection lists stay hidden; automatic refresh keeps the list in the active project's context.

Manual creation is available from **+ Note**. The quick-capture workflow runs the enabled AI stages; manually typing a note in the editor is a separate workflow.

## Optional AI processing

Under **Settings → Note processing**, choose a supplied model pair or select its generator and ranker. Titles, existing tags and links can be enabled independently. Creation of new topic tags has its own experimental switch and model pair.

Tags describe useful topics rather than every instruction. A note can legitimately have no tags or links. A different action or time about an existing subject should reuse the existing topic. Review generated metadata when its meaning matters.

Model downloads display their sizes and progress. Saving model choices may prepare missing files before applying the new selection. Imported models require their own compatibility and license review.

## Search, graph and chat

The library offers text search, tag/time filters and sorting. The graph displays saved links and provides an accessible note list beside the canvas. Selecting a note highlights its neighbors; opening it returns to the library.

Semantic search requires a search model. Chat uses the active project's indexed note fragments and provides clickable source notes and quotations. Generated answers may be incomplete or wrong. Open the source and check the quoted text.

New profiles download the search model during initial preparation. Later launches
reuse its verified cache. The semantic-search setup card stays hidden while the
model is ready and appears only when search is disabled or the model cannot load.
If preparation fails, you can explicitly continue with text search and retry later.
An existing text-only choice is retained until you enable semantic search.

Search, titles, tags, links and chat use ready-made models. Model fine-tuning is
disabled in this release; adding notes updates the search index without retraining.

## Save behavior and language

Choose autosave or manual save in Settings. With autosave disabled, save or discard changes before actions that require a clean note. Cancelling a dialog should leave the text unchanged.

The installer and initial interface start in English. After changing the interface language in Settings, save and use **Restart now**, or fully exit Noda and launch it again. Closing the window normally hides it to the tray. User-authored text and model answers are not translated by an interface-language change. Native Windows dialogs use the Windows language.

## Data and backups

| Data | Location |
| --- | --- |
| Markdown notes and project attachments | The project folder you selected |
| Project queue | `.noda-queue` inside that project folder |
| Project registry, app settings and local UI history | `%APPDATA%\Noda` |
| Downloaded runtime, models and runtime-managed index data | `%LOCALAPPDATA%\Noda\runtime` |

Noda does not encrypt these files. Protect your Windows account and folders as appropriate.

For a portable copy of notes, open the project's **… → Save a copy of notes…**. This export includes supported Markdown and image files, but excludes chat history, drafts, queue, trash, settings and index. Chat history has its own JSON export.

For a complete project backup, finish current work, fully exit Noda, and copy the whole project folder. Back up `%APPDATA%\Noda` separately for profile data. Reconnect the copied project folder through the UI if its location changes.

Trash can restore notes removed through the app. A backup remains necessary for filesystem deletion, corruption or disk failure.

## Updates and recovery

Before replacing a build, save edits, finish or safely stop current work, fully exit through the tray and make a backup. Do not copy a queue database over an app that is still using it.

Older Noda versions may not read newer queue formats. Current queue format 3 requires a compatible build; downgrading may require an earlier backup. Do not assume that replacing the executable alone restores data compatibility.

If setup fails, use its retry or supported text-only fallback, then check the reported component. Preserve the source and queue when reporting processing failures. Report a minimal synthetic reproduction instead of uploading a personal library.
