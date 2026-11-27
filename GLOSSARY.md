# SSH Astra

A modern desktop SSH/SFTP client: saved hosts, terminals and a file panel in one window.

## Language

### Hosts and connections

**Host**:
A saved, named set of connection settings (address, port, user, authentication, jump host) that the user opens to start working on a machine.
_Avoid_: Session, bookmark, server, profile

**Quick connect**:
Opens a Terminal directly from an SSH address entered in Home or the command palette.

**Temporary Host**:
The in-memory connection settings created by Quick connect. It is discarded when its last tab closes.
_Avoid_: Ad-hoc connection, session

**Group**:
A user-defined folder that organizes Hosts in the host list.
_Avoid_: Folder, category, tag

**Jump host**:
A Host that a connection is tunnelled through to reach another Host.
_Avoid_: Bastion, proxy, gateway

**Connection**:
One live, authenticated SSH transport to a Host; it carries every Terminal and File panel opened on that Host.
_Avoid_: Session, link

**Known host**:
A server identity (host key fingerprint) the user has accepted, shared with the system's OpenSSH `known_hosts`.
_Avoid_: Trusted host, fingerprint cache

### Working surfaces

**Terminal**:
One interactive shell running over a Connection, shown as a tab or a split pane.
_Avoid_: Session, console, shell tab

**Local terminal**:
A Terminal running a shell on the user's own machine, with no Connection.
_Avoid_: Local session

**Terminal log**:
A local plain-text file of a Terminal's output while logging is active. The same file continues across a remote Terminal's reconnections.
_Avoid_: Session log

**Broadcast**:
Sending the focused Terminal's keyboard input or paste to every running Terminal in the selected tab or window.
_Avoid_: Sync input, multi-exec

**File panel**:
The SFTP file browser beside a Terminal, browsing the same Host over the same Connection.
_Avoid_: SFTP browser, file manager, explorer

**Remote edit**:
A file from a Host opened in the local editor with automatic upload on save. File panels editing the same path on that Host share the Remote edit until the last one closes it.
_Avoid_: Download, transfer

**Port forward**:
A saved rule on a Host that tunnels traffic through its Connection: local, remote, or dynamic (SOCKS). One marked "start when connected" (auto-start) runs whenever its Host connects.
_Avoid_: Tunnel, port mapping

**Connect only**:
Connecting to a Host without opening a Terminal: the Connection stays open (with its auto-start Port forwards) until the user disconnects it.
_Avoid_: Background connection, headless session
