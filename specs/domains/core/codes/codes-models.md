# codes — Models

## Code Workspace

A registered workspace as seen by the codes domain. The browser identifies it by the
server-issued workspace id; the filesystem root is resolved only on the server.

## Relative Path

A path interpreted under one Code Workspace. It is never absolute, never allowed to contain parent
traversal, and is rejected if its resolved target leaves the workspace root.

## Code Directory Entry

A direct child returned by a directory listing.

| Field | Meaning                                             |
| ----- | --------------------------------------------------- |
| name  | Basename shown in the browser.                      |
| path  | Workspace-relative path used for follow-up reads.   |
| type  | `file` or `directory`; other filesystem kinds omit. |

## Code File Read

Metadata and optional content for one file.

| Field     | Meaning                                                |
| --------- | ------------------------------------------------------ |
| path      | Workspace-relative file path.                          |
| size      | Byte size on disk.                                     |
| binary    | Whether the inspected prefix indicates binary content. |
| truncated | Whether content was withheld due to size.              |
| content   | Text content, present only for eligible text files.    |

## Code Search Hit

One bounded search result.

| Field    | Meaning                                                       |
| -------- | ------------------------------------------------------------- |
| path     | Workspace-relative result path.                               |
| type     | `file` or `directory`.                                        |
| line     | One-based line number for content hits.                       |
| lineText | The matching line for content hits.                           |
| match    | The matched fragment or filename snippet, when cheaply known. |
