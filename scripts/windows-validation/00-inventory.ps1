#Requires -Version 5.1
<#
.SYNOPSIS
  W17 Windows-VM validation, step 00: host inventory.

.DESCRIPTION
  Read-only survey of the guest the rest of the suite will run against:
  OS/arch, VMware Tools presence (owner decision A4 — VMware Fusion on Apple
  Silicon), PowerShell version, admin state, Wi-Fi adapters (including a
  `netsh wlan show drivers` parse for hosted-network support and 5 GHz radio
  capability — the owner's 5.8 GHz AP-capable USB adapter is the Mobile
  Hotspot backend this whole program depends on), COM ports with VID:PID
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
# `netsh wlan show drivers` per-adapter block: parsed for "Hosted network
# supported" (same locale-neutral "host" substring rule as
# shared/wifiParse.js:174-192's parseNetshDrivers — that function only
# returns the hosted-network bit; this inventory ALSO reads "Radio types
# supported" because a 5 GHz-capable driver lists an 802.11 PHY that
# includes a/ac/ax/be, which the app itself never needs to know (Windows
# picks the band for Mobile Hotspot) but this bench DOES, because a
# 2.4 GHz-only dongle would silently fail the "5.8 GHz AP-capable" premise
# of owner decision A4.
function Get-W17WlanDrivers {
    $res = Invoke-W17Command -FilePath 'netsh' -ArgumentList @('wlan', 'show', 'drivers') -TimeoutSec 15
    if (-not $res.ok -and -not $res.stdout) {
        return @{ raw = $null; adapters = @(); error = $res.stderr }
    }
    $adapters = @()
    $current = $null
    foreach ($line in ($res.stdout -split "`r`n|`n")) {
        if ($line -match '^\s*Name\s*:\s*(.+)$' -and $line -notmatch 'Driver') {
            if ($current) { $adapters += [pscustomobject]$current }
            $current = [ordered]@{ name = $Matches[1].Trim(); driverVendor = $null; driverVersion = $null; hostedNetworkSupported = $null; radioTypesSupported = $null; likely5GHzCapable = $null }
            continue
        }
        if (-not $current) { continue }
        if ($line -match '^\s*Vendor\s*:\s*(.+)$') { $current.driverVendor = $Matches[1].Trim() }
        elseif ($line -match '^\s*Driver version\s*:\s*(.+)$') { $current.driverVersion = $Matches[1].Trim() }
        elseif ($line -match 'host' -and $line -match ':\s*(.+)$') {
            $val = $Matches[1].Trim()
            $current.hostedNetworkSupported = ($val -match '^(yes|ja|oui|si|sim|da)\b')
        }
        elseif ($line -match 'Radio types supported\s*:\s*(.+)$') {
            $val = $Matches[1].Trim()
            $current.radioTypesSupported = $val
            # 802.11a/ac/ax/be all live only in the 5 GHz (or 6 GHz) bands;
            # b/g/n-only listings mean 2.4 GHz only. This is a NAME match on
            # the PHY letters netsh prints, not a live RF/regulatory-domain
            # check — treat as a strong hint, not a guarantee (still
            # [win-TBD] until an actual 5 GHz hotspot is observed live).
            $current.likely5GHzCapable = ($val -match '(?i)\b802\.11\s*[a-z/]*[aA]\b|\bac\b|\bax\b|\bbe\b')
        }
    }
    if ($current) { $adapters += [pscustomobject]$current }
    return @{ raw = $res.stdout; adapters = $adapters }
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
function Get-W17Ds4Devices {
    $devices = @()
    try {
        $entities = Get-CimInstance -ClassName Win32_PnPEntity -ErrorAction Stop |
            Where-Object { $_.PNPDeviceID -match 'VID_054C&PID_(05C4|09CC)' }
        foreach ($e in $entities) {
            $devices += [pscustomobject]@{
                name = $e.Name
                pnpDeviceId = $e.PNPDeviceID
                status = $e.Status
                generation = if ($e.PNPDeviceID -match 'PID_05C4') { 'CUH-ZCT1x (v1)' } else { 'CUH-ZCT2x (v2)' }
            }
        }
    } catch {
        $notes.Add("HID enumeration failed: $($_.Exception.Message)")
    }
    return $devices
}
$data.dualShock4Devices = Get-W17Ds4Devices

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
