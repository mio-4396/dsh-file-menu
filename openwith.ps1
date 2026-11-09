# openwith.ps1 — the Windows half of the "Open with" list.
#
# The browser cannot ask Windows which applications can open a file type, and
# Node has no Shell API, so the Host half calls this script through
# powershell.exe:
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass
#                  -File openwith.ps1 -Action list -Path "D:\x\report.png"
#   powershell.exe ... -File openwith.ps1 -Action invoke -Path "D:\x\report.png" -AppName "画图" -AppIndex 2
#
# `list` prints one JSON object with the handlers the Shell itself would offer in
# its own "Open with" list; `invoke` launches the handler matching AppName (or
# AppIndex) for that file. Everything the page needs is on stdout; a failure is
# reported as {"ok":false,...} with a non-zero exit code so the Host can fall
# back to the system dialog instead of showing an empty menu.
#
# SHAssocEnumHandlers is used rather than the registry because it returns what
# the user actually sees: display names ("画图", not "mspaint.exe"), Store apps
# included, and handlers whose registration lives in several registry hives.

param(
    [Parameter(Mandatory = $true)][ValidateSet('list', 'invoke', 'dialog', 'copy')][string]$Action,
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$AppName = '',
    [int]$AppIndex = -1
)

$ErrorActionPreference = 'Stop'
# The Host reads stdout as UTF-8; the default console encoding here is the ANSI
# code page, which would mangle every Chinese application name.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public sealed class AssocApp
{
    public string Name { get; set; }
    public string DisplayName { get; set; }
    public string IconPath { get; set; }
    public int IconIndex { get; set; }
    public bool Recommended { get; set; }
    public object Handler { get; set; }
}

public sealed class AssocResult
{
    public int Filter;
    public List<AssocApp> Items = new List<AssocApp>();
}

public static class AssocApps
{
    const int FilterRecommended = 0x1;
    const int FilterAll = 0x0;

    [ComImport, Guid("973810ae-9599-4b88-9e4d-6ee98c9552da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IEnumAssocHandlers
    {
        [PreserveSig] int Next(uint celt, ref IntPtr rgelt, out uint fetched);
    }

    [ComImport, Guid("F04061AC-1659-4a3f-A954-775AA57FC083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAssocHandler
    {
        [PreserveSig] int GetName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] out string path, out int index);
        [PreserveSig] int IsRecommended();
        [PreserveSig] int MakeDefault([MarshalAs(UnmanagedType.LPWStr)] string description);
        [PreserveSig] int Invoke(IntPtr dataObject);
        [PreserveSig] int CreateInvoker(IntPtr dataObject, out IntPtr invoker);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHAssocEnumHandlers(string extension, int filter, out IEnumAssocHandlers handlers);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHParseDisplayName(string name, IntPtr context, out IntPtr pidl,
        uint attributesIn, out uint attributesOut);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHCreateDataObject(IntPtr pidlFolder, uint count, IntPtr[] items, IntPtr inner,
        ref Guid iid, out IntPtr value);

    [DllImport("shell32.dll")]
    static extern IntPtr ILFindLastID(IntPtr pidl);

    [DllImport("shell32.dll")]
    static extern IntPtr ILClone(IntPtr pidl);

    [DllImport("shell32.dll")]
    static extern bool ILRemoveLastID(IntPtr pidl);

    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
    static extern int AssocQueryStringW(int flags, int which, string association, string extra,
        System.Text.StringBuilder output, ref uint size);

    // OPENASINFO is exactly file, class and flags — there is no size field in
    // this structure, unlike most other Shell structs.
    [StructLayout(LayoutKind.Sequential)]
    struct OPENASINFO
    {
        public IntPtr File;
        public IntPtr ClassName;
        public int Flags;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHOpenWithDialog(IntPtr parent, ref OPENASINFO info);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetConsoleWindow();

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr window, int command);

    const int OpenAsAllowRegistration = 0x1;
    const int OpenAsExecute = 0x4;

    /// Hide this process's console window.
    ///
    /// The dialog cannot be shown by a process that was started without a
    /// console or with a hidden show-state, so this helper is launched as a
    /// normal console process and hides its own window right after start.
    public static void HideConsole()
    {
        try
        {
            IntPtr console = GetConsoleWindow();
            if (console != IntPtr.Zero) ShowWindow(console, 0);
        }
        catch
        {
            // A host without a console needs nothing hidden.
        }
    }

    /// The Shell's own "How do you want to open this file?" dialog.
    /// Blocks until the user closes it; returns "ok" or the HRESULT it failed with.
    /// No owner window is passed: the dialog belongs to the desktop the user is
    /// looking at, which is the window they just clicked the menu in.
    public static string ShowDialog(string path)
    {
        IntPtr file = Marshal.StringToHGlobalUni(path);
        try
        {
            var info = new OPENASINFO();
            info.File = file;
            info.ClassName = IntPtr.Zero;
            info.Flags = OpenAsAllowRegistration | OpenAsExecute;
            int result = SHOpenWithDialog(IntPtr.Zero, ref info);
            return result == 0 ? "ok" : "dialog:0x" + result.ToString("x8");
        }
        finally
        {
            Marshal.FreeHGlobal(file);
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool OpenClipboard(IntPtr newOwner);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool EmptyClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetClipboardData(uint format, IntPtr memory);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool CloseClipboard();

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GlobalLock(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GlobalUnlock(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GlobalFree(IntPtr memory);

    const uint GlobalMoveable = 0x0002;
    const uint GlobalZeroInit = 0x0040;
    const uint ClipboardHDrop = 15;

    /// Put one file on the clipboard as a file drop, the way Explorer's Copy does.
    /// Pasted into a folder it copies the file itself; pasted into a text field a
    /// file drop is added as its name.
    public static bool CopyFile(string path)
    {
        if (!System.IO.File.Exists(path)) return false;

        // CF_HDROP payload: DROPFILES header (20 bytes) then a double-null
        // terminated list of wide paths, the file name relative to nothing.
        byte[] list = System.Text.Encoding.Unicode.GetBytes(path + "\0\0");
        int size = 20 + list.Length;
        IntPtr memory = GlobalAlloc(GlobalMoveable | GlobalZeroInit, (UIntPtr)size);
        if (memory == IntPtr.Zero) return false;

        IntPtr buffer = GlobalLock(memory);
        if (buffer == IntPtr.Zero)
        {
            GlobalFree(memory);
            return false;
        }
        try
        {
            Marshal.WriteInt32(buffer, 0, 20);  // pFiles: header size
            Marshal.WriteInt32(buffer, 4, 0);   // pt.x
            Marshal.WriteInt32(buffer, 8, 0);   // pt.y
            Marshal.WriteInt32(buffer, 12, 0);  // fNC
            Marshal.WriteInt32(buffer, 16, 1);  // fWide: Unicode list
            Marshal.Copy(list, 0, new IntPtr(buffer.ToInt64() + 20), list.Length);
        }
        finally
        {
            GlobalUnlock(memory);
        }

        // Another process may hold the clipboard for a moment.
        bool opened = false;
        for (int attempt = 0; attempt < 10 && !opened; attempt++)
        {
            opened = OpenClipboard(IntPtr.Zero);
            if (!opened) System.Threading.Thread.Sleep(50);
        }
        if (!opened)
        {
            GlobalFree(memory);
            return false;
        }

        bool copied = false;
        try
        {
            EmptyClipboard();
            copied = SetClipboardData(ClipboardHDrop, memory) != IntPtr.Zero;
        }
        finally
        {
            CloseClipboard();
        }
        // On success the clipboard owns the block; freeing it would be a bug.
        if (!copied) GlobalFree(memory);
        return copied;
    }

    /// The extension the Shell associates, or "" for a file that carries none.
    static string ExtensionOf(string path)
    {
        try
        {
            string extension = System.IO.Path.GetExtension(path);
            return extension ?? "";
        }
        catch
        {
            return "";
        }
    }

    /// The friendly name Windows would put next to "open with" for this type.
    public static string DefaultAppName(string path)
    {
        try
        {
            var buffer = new System.Text.StringBuilder(1024);
            uint size = 1024;
            return AssocQueryStringW(0, 4, ExtensionOf(path), null, buffer, ref size) == 0
                ? buffer.ToString()
                : "";
        }
        catch
        {
            return "";
        }
    }

    /// Every handler for the type, recommended ones first and otherwise all of them.
    static AssocResult Collect(string extension)
    {
        var result = new AssocResult();
        foreach (int filter in new[] { FilterRecommended, FilterAll })
        {
            result.Items = Read(extension, filter);
            result.Filter = filter;
            if (result.Items.Count > 0) return result;
        }
        result.Items = new List<AssocApp>();
        result.Filter = -1;
        return result;
    }

    static List<AssocApp> Read(string extension, int filter)
    {
        var items = new List<AssocApp>();
        IEnumAssocHandlers handlers;
        if (SHAssocEnumHandlers(extension, filter, out handlers) != 0 || handlers == null) return items;

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int index = 0; index < 64; index++)
        {
            IntPtr raw = IntPtr.Zero;
            uint fetched;
            if (handlers.Next(1, ref raw, out fetched) != 0 || fetched == 0 || raw == IntPtr.Zero) break;
            IAssocHandler handler;
            try
            {
                handler = (IAssocHandler)Marshal.GetObjectForIUnknown(raw);
            }
            catch
            {
                Marshal.Release(raw);
                continue;
            }
            Marshal.Release(raw);

            var app = new AssocApp();
            string canonical = null;
            string display = null;
            string iconPath = null;
            int iconIndex = 0;
            try { handler.GetName(out canonical); } catch { }
            try { handler.GetUIName(out display); } catch { }
            try { handler.GetIconLocation(out iconPath, out iconIndex); } catch { }
            app.Name = canonical;
            app.DisplayName = display;
            app.IconPath = iconPath;
            app.IconIndex = iconIndex;
            app.Recommended = handler.IsRecommended() == 0;
            if (string.IsNullOrEmpty(app.DisplayName)) app.DisplayName = FallbackName(app.Name);
            if (string.IsNullOrEmpty(app.DisplayName)) continue;
            if (!seen.Add(app.DisplayName + "\u0000" + (app.Name ?? ""))) continue;
            app.Handler = handler;
            items.Add(app);
        }
        return items;
    }

    static string FallbackName(string canonical)
    {
        if (string.IsNullOrEmpty(canonical)) return "";
        int bang = canonical.IndexOf('!');
        string value = bang > 0 ? canonical.Substring(0, bang) : canonical;
        int slash = Math.Max(value.LastIndexOf('\\'), value.LastIndexOf('/'));
        if (slash >= 0) value = value.Substring(slash + 1);
        int dot = value.LastIndexOf('.');
        if (dot > 0) value = value.Substring(0, dot);
        return value.Trim();
    }

    /// Launch one handler for one file, addressing it the way the menu shows it.
    /// Returns "ok" or the stage that refused, so a failure is diagnosable.
    public static string Launch(string path, string preferredName, int preferredIndex)
    {
        var candidates = Collect(ExtensionOf(path));
        AssocApp target = null;
        if (!string.IsNullOrEmpty(preferredName))
        {
            foreach (var candidate in candidates.Items)
            {
                if (string.Equals(candidate.DisplayName, preferredName, StringComparison.OrdinalIgnoreCase))
                {
                    target = candidate;
                    break;
                }
            }
        }
        if (target == null && preferredIndex >= 0 && preferredIndex < candidates.Items.Count)
        {
            target = candidates.Items[preferredIndex];
        }
        if (target == null) return "no-handler";

        // The Shell hands about a "shell item list" data object rather than a
        // plain IShellItem: IAssocHandler::Invoke wants an IDataObject. The item
        // list is built from the file's parent folder plus the file's own child
        // ID; a data object created without that child carries no CF_HDROP, and
        // every handler then answers ERROR_NO_ASSOCIATION.
        IntPtr pidl;
        uint attributes;
        int stage = SHParseDisplayName(path, IntPtr.Zero, out pidl, 0, out attributes);
        if (stage != 0 || pidl == IntPtr.Zero) return "no-pidl:0x" + stage.ToString("x8");

        IntPtr child = ILFindLastID(pidl);
        IntPtr parent = ILClone(pidl);
        ILRemoveLastID(parent);

        Guid iidDataObject = new Guid("0000010e-0000-0000-c000-000000000046");
        IntPtr dataObject = IntPtr.Zero;
        try
        {
            stage = SHCreateDataObject(parent, 1, new[] { child }, IntPtr.Zero, ref iidDataObject, out dataObject);
            if (stage != 0 || dataObject == IntPtr.Zero) return "no-dataobject:0x" + stage.ToString("x8");
            int result = ((IAssocHandler)target.Handler).Invoke(dataObject);
            return result == 0 ? "ok" : "invoke:0x" + result.ToString("x8");
        }
        finally
        {
            // The data object may still point at the item list, so the PIDLs are
            // released only after the handler has run.
            if (dataObject != IntPtr.Zero) Marshal.Release(dataObject);
            Marshal.FreeCoTaskMem(parent);
            Marshal.FreeCoTaskMem(pidl);
        }
    }

    /// The ordered payload the Host serves to the menu.
    public static string Describe(string path)
    {
        string extension = ExtensionOf(path);
        string fallbackName = DefaultAppName(path);
        var result = Collect(extension);
        var parts = new List<string>();
        foreach (var app in result.Items)
        {
            bool isDefault = !string.IsNullOrEmpty(fallbackName)
                && string.Equals(app.DisplayName, fallbackName, StringComparison.OrdinalIgnoreCase);
            parts.Add("{\"name\":" + Quote(app.DisplayName)
                + ",\"canonical\":" + Quote(app.Name)
                + ",\"icon\":" + Quote(app.IconPath)
                + ",\"iconIndex\":" + app.IconIndex
                + ",\"recommended\":" + (app.Recommended ? "true" : "false")
                + ",\"default\":" + (isDefault ? "true" : "false") + "}");
        }
        return "{\"filter\":" + result.Filter + ",\"items\":[" + string.Join(",", parts.ToArray()) + "]}";
    }

    static string Quote(string value)
    {
        if (value == null) return "null";
        var builder = new System.Text.StringBuilder("\"");
        foreach (char character in value)
        {
            switch (character)
            {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (character < 0x20) builder.Append("\\u" + ((int)character).ToString("x4"));
                    else builder.Append(character);
                    break;
            }
        }
        return builder.Append("\"").ToString();
    }
}
'@

function Write-Answer {
    param([string]$Json)
    [Console]::Out.WriteLine($Json)
}

# Compiling the interop type costs about half a second, which the user would pay
# on every menu that lists applications. The compiled assembly is therefore kept
# in the temporary directory, keyed by a hash of the source, and loaded from
# there on later runs; a cache that cannot be written or loaded degrades to the
# in-memory compile instead of failing the request.
function Import-Interop {
    param([string]$Code)

    $hash = [System.BitConverter]::ToString(
        [System.Security.Cryptography.SHA256]::Create().ComputeHash(
            [System.Text.Encoding]::UTF8.GetBytes($Code))).Replace('-', '').Substring(0, 16)
    $root = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-file-menu'
    $assembly = Join-Path $root ("assoc-$hash.dll")

    if (Test-Path -LiteralPath $assembly) {
        try {
            Add-Type -Path $assembly
            return
        } catch {
            Remove-Item -LiteralPath $assembly -Force -ErrorAction SilentlyContinue
        }
    }

    try {
        New-Item -ItemType Directory -Force -Path $root | Out-Null
        $staging = "$assembly.$PID.tmp"
        Add-Type -TypeDefinition $Code -Language CSharp -OutputAssembly $staging
        Move-Item -LiteralPath $staging -Destination $assembly -Force
        Add-Type -Path $assembly
    } catch {
        Add-Type -TypeDefinition $Code -Language CSharp
    }
}

try {
    Import-Interop -Code $source

    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Answer '{"ok":false,"error":"path-not-found"}'
        exit 2
    }

    if ($Action -eq 'copy') {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            Write-Answer '{"ok":false,"error":"not-a-file"}'
            exit 2
        }
        if ([AssocApps]::CopyFile($Path)) {
            Write-Answer '{"ok":true,"copied":true}'
            exit 0
        }
        Write-Answer '{"ok":false,"error":"clipboard-failed"}'
        exit 3
    }

    if ($Action -eq 'list') {
        $described = [AssocApps]::Describe($Path)
        Write-Answer ('{"ok":true,' + $described.Substring(1))
        exit 0
    }

    if ($Action -eq 'dialog') {
        # The dialog cannot be shown by a process whose console was created
        # hidden, so the console is hidden here, after start-up, instead.
        [AssocApps]::HideConsole()
        # The dialog is modal and can stay open for a while, so the answer is
        # written first: the Host only needs to know the API was reached.
        Write-Answer '{"ok":true,"dialog":true}'
        [Console]::Out.Flush()
        $shown = [AssocApps]::ShowDialog($Path)
        if ($shown -ne 'ok') {
            Write-Answer ('{"ok":false,"error":"' + $shown + '"}')
            exit 3
        }
        exit 0
    }

    $applied = [AssocApps]::Launch($Path, $AppName, $AppIndex)
    if ($applied -eq 'ok') {
        Write-Answer '{"ok":true,"launched":true}'
        exit 0
    }
    Write-Answer ('{"ok":false,"error":"' + $applied + '"}')
    exit 3
} catch {
    $message = $_.Exception.Message -replace '\\', '\\\\' -replace '"', '\"'
    Write-Answer ('{"ok":false,"error":"' + $message + '"}')
    exit 1
}
