' Starts the token-launcher local web server hidden (no console window) at login.
' It rebuilds the site, serves it on http://localhost:8788, and opens your browser.
' A copy of this file is placed in the Windows Startup folder so it runs every boot.
Dim sh, projectDir, node
projectDir = "C:\Users\Evan\Desktop\tokenlaunch"
node = "C:\Program Files\nodejs\node.exe"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = projectDir
' 0 = hidden window, False = don't wait for it to finish
sh.Run """" & node & """ """ & projectDir & "\serve.mjs""", 0, False
