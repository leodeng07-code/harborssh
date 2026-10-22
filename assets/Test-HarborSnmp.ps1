# Read-only SNMP v2c probe. Windows PowerShell 5.1 / PowerShell 7.
# The community is requested securely and never printed or written to a file.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ComputerName,
    [ValidateRange(1, 65535)][int]$Port = 161,
    [ValidateRange(500, 10000)][int]$TimeoutMs = 5000,
    [ValidateRange(1, 3)][int]$Attempts = 2,
    [ValidateRange(1, 50)][int]$MaxRepetitions = 5,
    [switch]$Extended,
    [Security.SecureString]$Community
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Join-Bytes([object[]]$Parts) {
    $bytes = New-Object 'System.Collections.Generic.List[byte]'
    foreach ($part in $Parts) { $bytes.AddRange([byte[]]$part) }
    return ,$bytes.ToArray()
}
function New-Tlv([byte]$Tag, [byte[]]$Bytes) {
    $length = $Bytes.Length
    [byte[]]$encoded = @()
    if ($length -lt 128) { $encoded = @([byte]$length) }
    else {
        $chunks = New-Object 'System.Collections.Generic.List[byte]'
        while ($length -gt 0) { $chunks.Insert(0, [byte]($length -band 255)); $length = $length -shr 8 }
        $encoded = Join-Bytes @([byte[]]@([byte](128 + $chunks.Count)), $chunks.ToArray())
    }
    return ,(Join-Bytes @([byte[]]@($Tag), $encoded, $Bytes))
}
function New-Integer([int]$Value) {
    $bytes = New-Object 'System.Collections.Generic.List[byte]'
    do { $bytes.Insert(0, [byte]($Value -band 255)); $Value = $Value -shr 8 } while ($Value -gt 0)
    if ($bytes[0] -band 128) { $bytes.Insert(0, 0) }
    return ,(New-Tlv 2 $bytes.ToArray())
}
function New-Oid([string]$Value) {
    [long[]]$arcs = $Value.Split('.') | ForEach-Object { [long]$_ }
    $bytes = New-Object 'System.Collections.Generic.List[byte]'
    $bytes.Add([byte](40 * $arcs[0] + $arcs[1]))
    for ($i = 2; $i -lt $arcs.Length; $i++) {
        $arc = $arcs[$i]; $chunks = New-Object 'System.Collections.Generic.List[byte]'
        $chunks.Add([byte]($arc -band 127)); $arc = $arc -shr 7
        while ($arc -gt 0) { $chunks.Insert(0, [byte](128 -bor ($arc -band 127))); $arc = $arc -shr 7 }
        $bytes.AddRange($chunks.ToArray())
    }
    return ,(New-Tlv 6 $bytes.ToArray())
}
function Read-Tlv([byte[]]$Bytes, [ref]$Offset) {
    $offsetValue = [int]$Offset.Value
    if ($offsetValue + 2 -gt $Bytes.Length) { throw 'Truncated BER header' }
    $tag = $Bytes[$offsetValue++]; $length = [int]$Bytes[$offsetValue++]
    if ($length -band 128) {
        $count = $length -band 127; $length = 0
        if ($count -lt 1 -or $count -gt 4 -or $offsetValue + $count -gt $Bytes.Length) { throw 'Invalid BER length' }
        for ($i = 0; $i -lt $count; $i++) { $length = $length * 256 + $Bytes[$offsetValue++] }
    }
    if ($length -lt 0 -or $offsetValue + $length -gt $Bytes.Length) { throw 'Truncated BER body' }
    [byte[]]$value = @()
    if ($length) { $value = $Bytes[$offsetValue..($offsetValue + $length - 1)] }
    $Offset.Value = $offsetValue + $length
    return [pscustomobject]@{ Tag = [int]$tag; Value = $value }
}
function Read-Integer([byte[]]$Bytes) {
    [long]$value = 0
    foreach ($b in $Bytes) { $value = $value * 256 + $b }
    return $value
}
function Read-Oid([byte[]]$Bytes) {
    if (!$Bytes.Length) { return '' }
    $parts = New-Object 'System.Collections.Generic.List[long]'
    $parts.Add([long][Math]::Min(2, [Math]::Floor($Bytes[0] / 40)))
    $parts.Add([long]($Bytes[0] - 40 * $parts[0])); [long]$arc = 0
    for ($i = 1; $i -lt $Bytes.Length; $i++) {
        $arc = $arc * 128 + ($Bytes[$i] -band 127)
        if (!($Bytes[$i] -band 128)) { $parts.Add($arc); $arc = 0 }
    }
    return ($parts -join '.')
}
function Read-Response([byte[]]$Bytes, [int]$RequestId, [byte[]]$ExpectedCommunity) {
    $offsetValue = 0; $outer = Read-Tlv $Bytes ([ref]$offsetValue)
    if ($outer.Tag -ne 48) { throw 'Not an SNMP sequence' }
    $offsetValue = 0; $version = Read-Tlv $outer.Value ([ref]$offsetValue); $communityValue = Read-Tlv $outer.Value ([ref]$offsetValue); $pdu = Read-Tlv $outer.Value ([ref]$offsetValue)
    if ($version.Tag -ne 2 -or (Read-Integer $version.Value) -ne 1 -or $communityValue.Tag -ne 4 -or [Convert]::ToBase64String($communityValue.Value) -ne [Convert]::ToBase64String($ExpectedCommunity) -or $pdu.Tag -ne 162) { throw 'Unexpected SNMP version/community/PDU' }
    $offsetValue = 0; $id = Read-Tlv $pdu.Value ([ref]$offsetValue); $status = Read-Tlv $pdu.Value ([ref]$offsetValue); $index = Read-Tlv $pdu.Value ([ref]$offsetValue); $bindings = Read-Tlv $pdu.Value ([ref]$offsetValue)
    if ((Read-Integer $id.Value) -ne $RequestId) { throw 'Unexpected SNMP request ID' }
    $errorStatus = Read-Integer $status.Value
    if ($errorStatus -ne 0) { throw "SNMP agent replied with error status $errorStatus at binding $(Read-Integer $index.Value)" }
    $offsetValue = 0
    while ($offsetValue -lt $bindings.Value.Length) {
        $binding = Read-Tlv $bindings.Value ([ref]$offsetValue); $inner = 0
        $oid = Read-Tlv $binding.Value ([ref]$inner); $value = Read-Tlv $binding.Value ([ref]$inner)
        $display = switch ($value.Tag) {
            4 { [Text.Encoding]::UTF8.GetString($value.Value) -replace '[\x00-\x1f\x7f]', ' ' }
            6 { Read-Oid $value.Value }
            128 { 'noSuchObject (agent replied; object/view unavailable)' }
            129 { 'noSuchInstance (agent replied; instance unavailable)' }
            130 { 'endOfMibView (agent replied; end of accessible table)' }
            default { if ($value.Value.Length -le 8) { Read-Integer $value.Value } else { '<binary value>' } }
        }
        Write-Host "  $(Read-Oid $oid.Value) = $display"
    }
}

if (!$Community) { $Community = Read-Host 'SNMP v2c read community (hidden)' -AsSecureString }
$pointer = [IntPtr]::Zero; [byte[]]$communityBytes = @(); $failed = 0
try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Community)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if (!$plain) { throw 'Community must not be empty' }
    $communityBytes = [Text.Encoding]::UTF8.GetBytes($plain); $plain = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $pointer = [IntPtr]::Zero
    Write-Host "Read-only SNMP v2c: $ComputerName UDP $Port; timeout $TimeoutMs ms; attempts $Attempts"
    $tests = @(
        @{ Name = 'Single GET (sysUpTime)'; Tag = 160; Oids = @('1.3.6.1.2.1.1.3.0'); Repetitions = 0 },
        @{ Name = 'System GET (same initial OIDs as Harbor)'; Tag = 160; Oids = @('1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1.2.0'); Repetitions = 0 },
        @{ Name = "GETBULK (IF-MIB, $MaxRepetitions rows maximum)"; Tag = 165; Oids = @('1.3.6.1.2.1.2.2.1.1'); Repetitions = $MaxRepetitions }
    )
    if ($Extended) {
        foreach ($column in @(@{Name='ifDescr'; Oid='1.3.6.1.2.1.2.2.1.2'}, @{Name='ifName'; Oid='1.3.6.1.2.1.31.1.1.1.1'}, @{Name='ifAlias'; Oid='1.3.6.1.2.1.31.1.1.1.18'})) {
            $tests += @{ Name = "GETBULK ($($column.Name), $MaxRepetitions rows maximum)"; Tag = 165; Oids = @($column.Oid); Repetitions = $MaxRepetitions }
        }
    }
    foreach ($test in $tests) {
        Write-Host $test.Name; $ok = $false
        for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
            $udp = New-Object Net.Sockets.UdpClient
            try {
                $udp.Client.ReceiveTimeout = $TimeoutMs; $udp.Connect($ComputerName, $Port)
                $id = Get-Random -Minimum 1 -Maximum 1073741823
                $variables = foreach ($oid in $test.Oids) { New-Tlv 48 (Join-Bytes @((New-Oid $oid), (New-Tlv 5 ([byte[]]@())))) }
                $pdu = New-Tlv $test.Tag (Join-Bytes @((New-Integer $id), (New-Integer 0), (New-Integer $test.Repetitions), (New-Tlv 48 (Join-Bytes @($variables)))))
                $packet = New-Tlv 48 (Join-Bytes @((New-Integer 1), (New-Tlv 4 $communityBytes), $pdu))
                $watch = [Diagnostics.Stopwatch]::StartNew(); [void]$udp.Send($packet, $packet.Length)
                $sender = New-Object Net.IPEndPoint([Net.IPAddress]::Any, 0)
                $response = $udp.Receive([ref]$sender); $watch.Stop()
                Read-Response $response $id $communityBytes
                Write-Host "  PASS: response in $($watch.ElapsedMilliseconds) ms, $($response.Length) bytes"; $ok = $true; break
            } catch { Write-Host "  Attempt $attempt failed: $($_.Exception.Message)" }
            finally { $udp.Close() }
        }
        if (!$ok) { $failed++ }
    }
    if ($failed) { Write-Host 'Check v2c/community/UDP port, interface management access, ACL/Local policy and return route. If GET works but GETBULK fails, inspect the MIB view and reduce batch size.' }
    else { Write-Host 'All probes received SNMP replies. Share this output with the Harbor developer; no community is included.' }
} finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    if ($communityBytes.Length) { [Array]::Clear($communityBytes, 0, $communityBytes.Length) }
}
if ($failed) { exit 1 }
