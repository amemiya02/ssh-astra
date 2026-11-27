# Local Agent access for open Terminals

SSH Astra remains a desktop SSH client. Users can bring an MCP client they already use and decide which saved Hosts to share from the SSH Astra window. The app supplies access to the Terminals they opened and keeps control of the SSH Connection.

Agent access depends on the running window. The application owns the listener and the Terminal lifecycle, displays which tabs are shared, and lets the user revoke access from the status bar. The approval seam is designed for a decision in the window for an individual action. Permission follows the Host chosen by the user. A command's text alone cannot establish its effect on a particular Host, so the design leaves the decision with the user.

Both the global switch and the per-Host permission default to Off. Each saved Host can use Off, Read only, or Approval required. Both enabled levels currently expose the same read-only metadata tool. The approval interface is reserved for a future tool that asks the user to decide. Imports and duplicates start at Off. A Terminal opened through Quick connect remains private for its lifetime, including after its Temporary Host is saved. Terminals subsequently opened on the saved Host can be opted in.

## Local transport

Under **Settings → Agent access**, turn on the global switch. In the desired Host's editor, expand **Advanced** and choose its Agent access level. Configure the MCP client to run the installed SSH Astra executable with one argument, `mcp`. Use the full executable path if the client cannot resolve `sshastra` on its PATH. In a macOS bundle the executable is in `Contents/MacOS`.

The subcommand forwards newline-delimited stdio messages to the running application's local endpoint. On Linux and macOS the Unix socket lives in the app's private per-user directory in `/tmp`. The directory and socket have owner-only permissions, and both ends verify the peer user. On Windows the named pipe permits only the current user SID, rejects remote clients, and the proxy verifies the pipe server's user. The client configuration consists of the executable and argument. The endpoint uses local IPC and is closed on revocation and app exit.

`list_terminals` returns each eligible Terminal's ID, saved Host name, shell title (falling back to the Host name), reported current directory when available, and Connection state. Results are bounded and include a cursor if there are more entries. Names, titles, and paths are untrusted inputs to clients. The application logs no requests or Terminal output for Agent access.
