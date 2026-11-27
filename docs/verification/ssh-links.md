# SSH link checks

Use an installed build in a disposable desktop account or VM. Select SSH Astra as the `ssh:` handler if the desktop offers a choice. Use a test SSH server and dummy credentials. Observe new connections in the test server's logs.

| Platform | Open the link in the installed app |
| --- | --- |
| macOS | Install the bundled app in Applications. Click an `ssh://` link or run `open 'ssh://tester@example.test:2222'`. |
| Windows | Install the MSI or NSIS package. Click a link or run `Start-Process 'ssh://tester@example.test:2222'` in PowerShell. |
| Linux | Install the Debian or RPM package in a desktop session. Click a link or run `xdg-open 'ssh://tester@example.test:2222'`. For AppImage, first integrate it using an AppImage launcher that installs its desktop entry. |

1. Quit SSH Astra completely and open a link. The app should open to a confirmation showing the address, port and username. Cancel it and check that no Terminal opened and the server saw no connection.
2. Repeat with the app already running, including with a minimized window. If multiple windows are open, check that the window brought forward shows the single prompt.
3. Open a link whose address, port and user match exactly one saved Host. Its name should appear in the prompt. Confirm and check that it opens with that Host's existing settings. Change any of the three values and confirm that the prompt instead offers Quick connect. If multiple saved Hosts have exactly the same destination, check that the app offers Quick connect.
4. Open `ssh://tester:dummy-password@[::1]:2222`. Check that the prompt shows `tester`, `::1` and `2222`. Cancel and check that the dummy password appears in neither the window nor the application logs. A link with no username or port should show the local account name and port `22`.
5. Open a link with a path, query, fragment or invalid port. The app should leave the workspace unchanged and the server should see no connection.
