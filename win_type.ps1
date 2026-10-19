# Types text and special keys into the focused window with SendInput (Windows). Used by autotype.js.
# Input arrives on STDIN as base64-encoded UTF-8 JSON, never on the command line (other processes can read command lines):
#   {"delay": <ms between keys>, "ops": [ {"t":"text","v":"..."} | {"t":"key","v":"tab|enter|alttab|shifttab"} | {"t":"sleep","ms":n} ]}
# Text is sent as Unicode characters (KEYEVENTF_UNICODE), so it does not depend on the keyboard layout.
# Windows blocks synthetic input into windows running as administrator (UIPI): Kyuch must not be "less privileged" than the target.
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class KyuchInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

  static void Send(ushort vk, ushort scan, uint flags) {
    INPUT[] i = new INPUT[1];
    i[0].type = 1; // INPUT_KEYBOARD
    i[0].u.ki.wVk = vk; i[0].u.ki.wScan = scan; i[0].u.ki.dwFlags = flags;
    if (SendInput(1, i, Marshal.SizeOf(typeof(INPUT))) != 1) throw new Exception("SendInput was blocked (is the target window running as administrator?)");
  }
  public static void VkDown(ushort vk) { Send(vk, 0, 0); }
  public static void VkUp(ushort vk) { Send(vk, 0, KEYEVENTF_KEYUP); }
  public static void Char(char c) { Send(0, c, KEYEVENTF_UNICODE); Send(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP); }
}
"@

$VK_TAB = 0x09; $VK_RETURN = 0x0D; $VK_SHIFT = 0x10; $VK_MENU = 0x12   # MENU = Alt
$b64 = [Console]::In.ReadToEnd().Trim()
$job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) | ConvertFrom-Json
$delay = [int]$job.delay
if ($delay -lt 0 -or $delay -gt 1000) { throw 'bad key delay' }

function Pause([int]$ms) { if ($ms -gt 0) { [Threading.Thread]::Sleep($ms) } }
function Tap([int]$vk) { [KyuchInput]::VkDown($vk); Pause $delay; [KyuchInput]::VkUp($vk); Pause $delay }
function Chord([int]$mod, [int]$vk) {
  [KyuchInput]::VkDown($mod); Pause 40; [KyuchInput]::VkDown($vk); Pause 40; [KyuchInput]::VkUp($vk); Pause 40; [KyuchInput]::VkUp($mod); Pause $delay
}

foreach ($op in $job.ops) {
  switch ($op.t) {
    'sleep' { $ms = [int]$op.ms; if ($ms -lt 0 -or $ms -gt 60000) { throw 'bad sleep' }; Pause $ms }
    'key'   {
      switch ($op.v) {
        'tab'      { Tap $VK_TAB }
        'enter'    { Tap $VK_RETURN }
        'alttab'   { Chord $VK_MENU $VK_TAB }
        'shifttab' { Chord $VK_SHIFT $VK_TAB }
        default    { throw "unknown key $($op.v)" }
      }
    }
    'text'  {
      foreach ($c in ([string]$op.v).ToCharArray()) {
        if ($c -eq "`n") { Tap $VK_RETURN } elseif ($c -eq "`t") { Tap $VK_TAB } else { [KyuchInput]::Char($c); Pause $delay }
      }
    }
    default { throw "unknown operation $($op.t)" }
  }
}
