Option Explicit

' wscript.exe is a GUI process: the scheduler never opens a console for this launcher.
' Wait for PowerShell and return its exit code so task limits and overlap handling still apply.
If WScript.Arguments.Count <> 3 Then WScript.Quit 64

Dim shell, files, i, value, command, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
For i = 0 To 2
    value = WScript.Arguments(i)
    If InStr(value, Chr(34)) > 0 Or InStr(value, "%") > 0 Or _
       InStr(value, vbCr) > 0 Or InStr(value, vbLf) > 0 Then WScript.Quit 64
    If Not files.FileExists(value) Then WScript.Quit 66
    If StrComp(files.GetAbsolutePathName(value), value, vbTextCompare) <> 0 Then WScript.Quit 64
Next

command = Chr(34) & WScript.Arguments(0) & Chr(34) & _
    " -NoProfile -NonInteractive -WindowStyle Hidden -File " & _
    Chr(34) & WScript.Arguments(1) & Chr(34) & " -Action Check -ConfigPath " & _
    Chr(34) & WScript.Arguments(2) & Chr(34)
result = shell.Run(command, 0, True)
WScript.Quit result
