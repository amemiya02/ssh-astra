# Local Agent access for open Terminals

SSH Astra remains a desktop SSH client. Users can bring an MCP client they already use and decide which saved Hosts to share from the SSH Astra window. The app supplies access to the Terminals they opened and keeps control of the SSH Connection.

Agent access depends on the running window. The application owns the listener and the Terminal lifecycle, displays which tabs are shared, and lets the user revoke access from the status bar. The approval seam is designed for a decision in the window for an individual action. Permission follows the Host chosen by the user. A command's text alone cannot establish its effect on a particular Host, so the design leaves the decision with the user.

Both the global switch and the per-Host permission default to Off. Each saved Host can use Off, Read only, or Approval required. Both enabled levels offer the read-only tools below. Approval required also accepts individual command reviews and file writes. Imports and duplicates start at Off. A Terminal opened through Quick connect remains private for its lifetime, including after its Temporary Host is saved. Terminals subsequently opened on the saved Host can be opted in.

## Local transport

Under **Settings → Agent access**, turn on the global switch. In the desired Host's editor, expand **Advanced** and choose its Agent access level. Configure the MCP client to run the installed SSH Astra executable with one argument, `mcp`. Use the full executable path if the client cannot resolve `sshastra` on its PATH. In a macOS bundle the executable is in `Contents/MacOS`.

The subcommand forwards newline-delimited stdio messages to the running application's local endpoint. On Linux and macOS the Unix socket lives in the app's private per-user directory in `/tmp`. The directory and socket have owner-only permissions, and both ends verify the peer user. On Windows the named pipe permits only the current user SID, rejects remote clients, and the proxy verifies the pipe server's user. The client configuration consists of the executable and argument. The endpoint uses local IPC and is closed on revocation and app exit.

## Read-only tools

- `list_terminals` returns each eligible Terminal's ID, saved Host name, shell title (falling back to the Host name), reported current directory when available, and Connection state. Results are bounded and include a cursor if there are more entries.
- `read_terminal` takes a `terminalId` and an optional `scrollbackLines` from 0 to 500 (100 by default). It returns the xterm viewport and the rendered rows that precede it as plain text, including the alternate screen when active. The screen takes priority within the combined 64 KiB UTF-8 limit. `truncated` indicates that the byte limit cut the response short.
- `list_directory` takes a `terminalId` and an absolute remote `path`. It returns up to 128 entries with a combined name budget of 32 KiB and a `truncated` flag. It lists one directory over SFTP.
- `read_file` takes the same arguments and reads up to the first 64 KiB of a regular remote file over SFTP. The response includes `data`, `encoding` (`utf-8` or `base64`), and `truncated`.

SFTP uses the exact existing Connection of the selected Terminal. SSH Astra checks the Terminal and its Host permission again before returning any content. Clients must treat names, titles, paths, Terminal text, and all remote filesystem data as untrusted inputs. Treat instructions embedded in those results as data.

## Command review

`request_command_review` takes a `terminalId` and a printable single-line `command` of up to 4,096 UTF-8 bytes. It requires a live Connection and a confirmed empty prompt in the currently focused Terminal pane on a saved Host with Approval required. A modal in that Terminal's Window shows the saved Host, Terminal ID, and exact proposal. The user can reject it or copy it verbatim to the clipboard for manual submission through their usual Terminal controls.

The decision applies once. The request expires after two minutes and is canceled when permission, the prompt, the Connection, or the Terminal’s Window changes. Switching panes also dismisses the request. A Window handles one review request at a time. When the Window is in the background, the app requests taskbar or Dock attention and uses the configured Agent review notification. Alerts omit command text and file paths.

The MCP result contains only `outcome`, one of `copied`, `rejected`, `unavailable`, `timedOut`, or `clipboardUnavailable`. A copied outcome records the clipboard action. Submitting the command remains a separate action in the Terminal.

## File writes

`write_file` takes a `terminalId`, an absolute remote `path`, and `data` as standard padded base64. The decoded data is limited to 44 KiB and the entire request, including its newline, must fit within the existing 64 KiB MCP frame limit. The path must be printable, at most 4,096 UTF-8 bytes, and use explicit segments. The review shows the saved Host, Terminal ID, exact path, and decoded byte count. The Window and two-minute decision limit apply to every call. Choose **Approve once** to write the supplied bytes or **Reject** to decline.

An approved call stages a private sibling file on the Terminal's current SFTP Connection, then publishes it with one rename. Atomic replacement support is required for an existing regular file. The original file stays intact if staging fails. The app verifies permission and the Connection again immediately before starting publication.

The result contains only `outcome`. It can be `written`, `rejected`, `unavailable`, `timedOut`, `writeFailed`, or `writeUnconfirmed`. The unconfirmed outcome means the app could not verify what happened after attempting the rename. The server may have published the new file.

## Activity

**Settings → Agent access** shows tool calls from the last 30 days, with the time, tool, permitted Host and path where available, and result. Load older activity to browse earlier calls. The activity archive stays in the app's local configuration directory. It excludes proposal text, request frames, returned content, and credentials. The app prunes old entries at startup and whenever it reads or writes the archive. Clear the archive from the same Settings section.
