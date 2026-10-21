' -- Shinchan Helper - start the 24/7 host with NO console window --
' Put a copy in the Windows Startup folder so the bot boots with the PC.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\Zalux\Downloads\StuffDiscord"
sh.Run "cmd /c bot-24-7.bat", 0, False
