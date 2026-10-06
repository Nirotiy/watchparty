param([Parameter(Mandatory)][string]$ConfigurationFile, [Parameter(Mandatory)][string]$Origin, [ValidateSet('Site', 'MusicSession')][string]$Mode = 'Site')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WatchPartyTestCredential {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct Credential {
        public uint Flags, Type;
        public string TargetName, Comment;
        public long LastWritten;
        public uint BlobSize;
        public IntPtr Blob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool Read(string target, uint type, uint flags, out IntPtr result);
    [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool Write(ref Credential value, uint flags);
    [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);
    public static bool CreateIfAbsent(string target, string user, string password) {
        IntPtr existing;
        if (Read(target, 1, 0, out existing)) { CredFree(existing); return false; }
        if (Marshal.GetLastWin32Error() != 1168) throw new Exception("credential_read_failed");
        var bytes = System.Text.Encoding.UTF8.GetBytes(password);
        var blob = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            var value = new Credential { Type=1, TargetName=target, UserName=user, BlobSize=(uint)bytes.Length, Blob=blob, Persist=2 };
            if (!Write(ref value, 0)) throw new Exception("credential_write_failed");
            return true;
        } finally {
            Array.Clear(bytes, 0, bytes.Length);
            for (int i=0; i<bytes.Length; i++) Marshal.WriteByte(blob, i, 0);
            Marshal.FreeHGlobal(blob);
        }
    }
}
'@
$configuration = Get-Content -LiteralPath $ConfigurationFile -Raw | ConvertFrom-Json
if ($Mode -eq 'MusicSession') {
    $blob = @{MP_SESSION=$configuration.session; MP_CSRF=$configuration.csrf} | ConvertTo-Json -Compress
    $created = [WatchPartyTestCredential]::CreateIfAbsent("MusicParty Desktop/session/$Origin", 'MusicParty', $blob)
} else {
    $created = [WatchPartyTestCredential]::CreateIfAbsent("WatchParty/site-basic/$Origin", $configuration.siteUsername, $configuration.sitePassword)
}
Write-Output (@{created=$created} | ConvertTo-Json -Compress)
