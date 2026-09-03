#Requires -Version 7.0
<#
.SYNOPSIS
  W17 Windows-VM validation, step 00: host inventory.

.DESCRIPTION
  Read-only survey of the guest the rest of the suite will run against:
  OS/arch, VMware Tools presence (owner decision A4 — VMware Fusion on Apple
  Silicon), PowerShell version, admin state, Wi-Fi adapters (including a
  `netsh wlan show drivers` parse for hosted-network support and 5 GHz radio
  capability — an AP-capable 5 GHz USB adapter is the Mobile Hotspot backend
  steps 30/40 depend on, and it is NOT yet on hand: CURRENT_STATUS.md lists it
  under "Owner residue: shopping only", and the adapter
  HARDWARE_INVENTORY.md:183 records as present is an RT5370, which is
  2.4 GHz and whose AP mode is unverified — so this step's honest expected
  answer today is likely5GHzCapable = $false), COM ports with VID:PID
  (the ELRS TX serial adapter shows up here — its exact VID:PID is
  [win-TBD], the owner has not named a specific USB-serial chipset), HID
  devices matching the DualShock 4's known VID:PID pairs (054C:05C4 first-gen
  CUH-ZCT1x, 054C:09CC second-gen CUH-ZCT2x), any already-installed W17 apps
  (registry Uninstall keys), and firewall profile state.

  Never fails on a missing subsystem — an inventory step reports what IS and
  ISN'T there; 10/30/40/50 are where "missing X" becomes a FAIL.

.EXAMPLE
  pwsh -File 00-inventory.ps1
  pwsh -File 00-inventory.ps1 -ResultsDir C:\w17\results
#>
[CmdletBinding()]
param(
    [string] $ResultsDir
)

. (Join-Path $PSScriptRoot 'lib\common.ps1')

$data = [ordered]@{}
$notes = New-Object System.Collections.Generic.List[string]

# --- OS / arch --------------------------------------------------------------
try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
    $data.os = [ordered]@{
        caption      = $os.Caption
        version      = $os.Version
        buildNumber  = $os.BuildNumber
        osArchitecture = $os.OSArchitecture
        is64BitOS    = [Environment]::Is64BitOperatingSystem
        processorArchEnv = $env:PROCESSOR_ARCHITECTURE
        totalMemoryGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
    }
} catch {
    $data.os = $null
    $notes.Add("OS query failed: $($_.Exception.Message)")
}

# --- Virtualization (owner decision A4: VMware Fusion guest) ---------------
$data.virtualization = Get-W17VirtualizationInfo

# --- PowerShell -------------------------------------------------------------
$data.powershell = [ordered]@{
    version = $PSVersionTable.PSVersion.ToString()
    edition = $PSVersionTable.PSEdition
}

# --- Admin state (mirrors main/hotspot.js's PS_ELEV token approach) --------
$data.isAdministrator = Test-W17IsAdministrator

# --- Wi-Fi adapters ----------------------------------------------------------
# `netsh wlan show drivers`, parsed the way shared/wifiParse.js parses netsh:
# by SHAPE, never by English label text (wifiParse.js:174-181 spells the rule
# out — "the label is localized but keeps the latin word host in every locale
# we could check"). That function returns only the hosted-network bit; this
# inventory ALSO reads the radio types, because a 2.4 GHz-only dongle would
# silently fail the AP-capable premise of owner decision A4 and the app itself
# never needs to know (Windows picks the band for Mobile Hotspot).
#
# TWO PARSE BUGS FIXED HERE (review findings N1 and N2), both of which made
# this survey return nothing rather than something wrong:
#
# N1 — the block header. The old code opened a new adapter block on
# `^\s*Name\s*:`. `netsh wlan show drivers` has no such line: its per-adapter
# header is the UNINDENTED `Interface name: Wi-Fi` (the `Name :` form belongs
# to `show interfaces`, which is a different command). So $current stayed
# $null, every field line hit the `if (-not $current) { continue }` guard, and
# `adapters` was ALWAYS empty — the 5 GHz / hosted-network answer A4 depends
# on silently yielded nothing at all. The new rule is structural and
# locale-neutral: an unindented `<anything>: <value>` line starts a block and
# its value is the adapter name; indented `<label> : <value>` lines are that
# block's fields; a blank line ends nothing (netsh separates the header from
# its fields with one).
#
# N2 — the 5 GHz test. `\bac\b` and `\bax\b` can never match inside the token
# `802.11ac`, because there is no word boundary between `11` and `ac`; only a
# bare `802.11a` could ever fire. Replaced by tokenising every `802.11<phy>`
# the value contains and classifying the PHY letters explicitly.
#
# The classification is a NAME match on what the driver claims, not a live
# RF/regulatory-domain check, and stays [win-TBD] until a 5 GHz hotspot is
# actually observed. It reports a tri-state, never a false negative dressed as
# a fact: $true (a 5 GHz-only PHY is listed), $false (only 2.4 GHz-only PHYs),
# $null (no 802.11 token found, or only ambiguous ones).
$script:W17YesWords = '^(yes|ja|oui|s[ií]|sim|da|да|tak|evet)\b'   # shared/wifiParse.js:179
$script:W17NoWords  = '^(no|nein|non|nao|não|nie|нет|hay[ıi]r)\b'  # shared/wifiParse.js:180

function Get-W17RadioBandClass {
    param([string] $RadioTypesValue)
    # 802.11a and 802.11ac exist ONLY in 5 GHz. 802.11ax/be are 5/6 GHz-capable
    # (they also define 2.4 GHz modes, so they are a strong hint, not a proof —
    # they are counted as 5 GHz-capable here and the raw string is kept so a
    # human can second-guess it). b/g are 2.4 GHz only. n is dual-band capable
    # and therefore says nothing either way.
    # @(...) is required: a single regex match would otherwise collapse to a
    # bare string, and `.Count` on a string throws under Set-StrictMode Latest.
    $tokens = @([regex]::Matches($RadioTypesValue, '(?i)802\.11\s*([a-z]+)') | ForEach-Object { $_.Groups[1].Value.ToLowerInvariant() })
    if ($tokens.Count -eq 0) { return @{ likely5GHzCapable = $null; phyTokens = @(); why = 'no 802.11 PHY token found in the value' } }
    $fiveOnly = @($tokens | Where-Object { $_ -in @('a', 'ac') })
    $fiveHint = @($tokens | Where-Object { $_ -in @('ax', 'be') })
    $twoOnly  = @($tokens | Where-Object { $_ -in @('b', 'g') })
    if ($fiveOnly.Count -gt 0) { return @{ likely5GHzCapable = $true;  phyTokens = $tokens; why = "5 GHz-only PHY listed: $($fiveOnly -join ',')" } }
    if ($fiveHint.Count -gt 0) { return @{ likely5GHzCapable = $true;  phyTokens = $tokens; why = "5/6 GHz-capable PHY listed: $($fiveHint -join ',') (also defines 2.4 GHz modes — hint, not proof)" } }
    if ($twoOnly.Count -gt 0)  { return @{ likely5GHzCapable = $false; phyTokens = $tokens; why = "only 2.4 GHz-only PHYs listed: $($twoOnly -join ',')" } }
    return @{ likely5GHzCapable = $null; phyTokens = $tokens; why = "only band-ambiguous PHYs listed: $($tokens -join ',')" }
}

function Get-W17ParsedWlanDrivers {
    param([string] $Text)
    $adapters = @()
    $current = $null
    foreach ($line in ($Text -split "`r`n|`n")) {
        if (-not $line.Trim()) { continue }
        # Unindented "<label>: <value>" -> a new adapter block (netsh prints
        # "Interface name: Wi-Fi" at column 0; every field is indented).
        if ($line -notmatch '^\s' -and $line -match '^[^:]+:\s*(.*)$') {
            if ($current) { $adapters += [pscustomobject]$current }
            $current = [ordered]@{
                name = $Matches[1].Trim(); driverVendor = $null; driverVersion = $null
                hostedNetworkSupported = $null; radioTypesSupported = $null
                likely5GHzCapable = $null; bandClassWhy = $null; phyTokens = @()
            }
            continue
        }
        if (-not $current) { continue }
        if ($line -notmatch '^\s+(.+?)\s*:\s*(.*)$') { continue }
        $label = $Matches[1].Trim()
        $value = $Matches[2].Trim()
        if ($value -match '(?i)^\s*802\.11[a-z]+([\s,/]+802\.11[a-z]+)*\s*$') {
            # The radio-types LABEL is localized ("Unterstützte Funktypen"),
            # but the PHY names in its VALUE are literal everywhere. Match on
            # the value, exactly like wifiParse.js matches SSID by shape.
            # The value must be NOTHING BUT 802.11 tokens: a driver NAME such
            # as "Broadcom 802.11ac Netzwerkadapter" also contains "802.11",
            # and matching a bare substring would misfile it as the radio
            # types (caught by the DE fixture in the unit test).
            $current.radioTypesSupported = $value
            $band = Get-W17RadioBandClass -RadioTypesValue $value
            $current.likely5GHzCapable = $band.likely5GHzCapable
            $current.bandClassWhy = $band.why
            $current.phyTokens = $band.phyTokens
        }
        elseif ($label -match '(?i)host') {
            # Tri-state, matching shared/wifiParse.js:182-193: yes -> $true,
            # no -> $false, anything else -> $null ("unknown"), never a
            # silent $false. The old code collapsed unknown to $false.
            if ($value -match $script:W17YesWords) { $current.hostedNetworkSupported = $true }
            elseif ($value -match $script:W17NoWords) { $current.hostedNetworkSupported = $false }
        }
        elseif ($label -match '(?i)^vendor$') { $current.driverVendor = $value }
        elseif ($label -match '(?i)^(driver )?version$') { $current.driverVersion = $value }
    }
    if ($current) { $adapters += [pscustomobject]$current }
    return $adapters
}

function Get-W17WlanDrivers {
    $res = Invoke-W17Command -FilePath 'netsh' -ArgumentList @('wlan', 'show', 'drivers') -TimeoutSec 15
    if (-not $res.ok -and -not $res.stdout) {
        return @{ raw = $null; adapters = @(); error = $res.stderr }
    }
    # The raw text is always kept: if the parse above is still wrong against a
    # real Windows locale/build ([win-TBD] — no netsh was available to this
    # session), the evidence is not lost and a human can read it.
    return @{ raw = $res.stdout; adapters = (Get-W17ParsedWlanDrivers -Text $res.stdout) }
}

try {
    $data.wifiAdapters = Get-W17WlanDrivers
} catch {
    $data.wifiAdapters = $null
    $notes.Add("netsh wlan show drivers failed: $($_.Exception.Message)")
}

try {
    $ifRes = Invoke-W17Command -FilePath 'netsh' -ArgumentList @('wlan', 'show', 'interfaces') -TimeoutSec 15
    $data.wifiInterfacesRaw = $ifRes.stdout
} catch {
    $data.wifiInterfacesRaw = $null
}

# --- COM ports with VID:PID --------------------------------------------------
# The ELRS TX handset rides in here as a USB-serial adapter. Its VID:PID is
# genuinely unknown at this point (the owner has not named a chipset for the
# validation VM's ELRS TX dongle) — reported as-is, never guessed.
function Get-W17ComPorts {
    $ports = @()
    try {
        $entities = Get-CimInstance -ClassName Win32_PnPEntity -ErrorAction Stop |
            Where-Object { $_.Name -match '\(COM\d+\)' -or $_.PNPClass -eq 'Ports' }
        foreach ($e in $entities) {
            $comMatch = [regex]::Match($e.Name, '\(COM(\d+)\)')
            $vidPid = [regex]::Match($e.PNPDeviceID, 'VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})')
            $ports += [pscustomobject]@{
                name = $e.Name
                com  = if ($comMatch.Success) { "COM$($comMatch.Groups[1].Value)" } else { $null }
                vid  = if ($vidPid.Success) { $vidPid.Groups[1].Value } else { $null }
                pid  = if ($vidPid.Success) { $vidPid.Groups[2].Value } else { $null }
                pnpDeviceId = $e.PNPDeviceID
                status = $e.Status
            }
        }
    } catch {
        $notes.Add("COM port enumeration failed: $($_.Exception.Message)")
    }
    return $ports
}
$data.comPorts = Get-W17ComPorts

# --- HID: DualShock 4 (VID 054C, PID 05C4 or 09CC) --------------------------
# Get-W17Ds4Devices now lives in lib/common.ps1 (shared with
# 60-r15-pad-unplug.ps1, which polls it across an operator-driven physical
# unplug/replug — see that file's header for what it can and cannot prove).
$ds4Result = Get-W17Ds4Devices
$data.dualShock4Devices = $ds4Result.devices
if ($ds4Result.error) { $notes.Add("HID enumeration failed: $($ds4Result.error)") }

# --- Installed W17 apps (registry Uninstall keys) ---------------------------
$data.installedW17Apps = Get-W17InstalledApps -NamePattern 'W17'

# --- Firewall profiles -------------------------------------------------------
try {
    $data.firewallProfiles = Get-NetFirewallProfile -ErrorAction Stop |
        Select-Object Name, Enabled, DefaultInboundAction, DefaultOutboundAction
} catch {
    $data.firewallProfiles = $null
    $notes.Add("Get-NetFirewallProfile failed (module may be unavailable): $($_.Exception.Message)")
}

$data.notes = @($notes)

$result = New-W17Result -Script '00-inventory' -Ok $true -Summary 'host inventory collected (informational — no pass/fail gate)' -Data $data
Save-W17Result -Result $result -ResultsDir $ResultsDir
exit (Write-W17Result $result)
