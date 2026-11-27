[SessionInfo]
Version=8.0
Description=Xshell session file

[CONNECTION]
Protocol=SSH
Host=build.example.test
Port=2222

[CONNECTION:AUTHENTICATION]
UserName=builder
UserKeyName=C:\test-keys\build.key
Password=XSH_TEST_SECRET_SAVED
Passphrase=XSH_TEST_SECRET_KEY

[CONNECTION:PROXY]
Type=JUMPHOST
Host=2001:db8::16
Port=2202
UserName=ops
Password=XSH_TEST_SECRET_JUMP

[CONNECTION:LOGINSCRIPT]
ScriptFile=XSH_TEST_SECRET_SCRIPT

[TERMINAL]
Encoding=UTF-8
