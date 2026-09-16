param(
    [Parameter(Mandatory = $true)][string]$EvidencePath,
    [Parameter(Mandatory = $true)][string]$HelperPath,
    [Parameter(Mandatory = $true)][string]$PipeName
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Only temporary-account setup requires elevation.'
}
if ($PipeName -notmatch '^gcr-service-v1-[a-f0-9]{64}$') {
    throw 'Invalid verification pipe name.'
}
$fixtureId = [guid]::NewGuid().ToString('N')
$accountName = 'GcrW03' + $fixtureId.Substring(0, 10)
$fixtureRoot = Join-Path $env:PUBLIC ('gcr-w03-' + $fixtureId)
$fixtureFull = [IO.Path]::GetFullPath($fixtureRoot)
$publicFull = [IO.Path]::GetFullPath($env:PUBLIC).TrimEnd('\') + '\'
if (-not $fixtureFull.StartsWith($publicFull,
    [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid fixture root.' }
$random = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($random)
$password = ConvertTo-SecureString (
    [Convert]::ToBase64String($random) + 'aA!7'
) -AsPlainText -Force
$account = $null
$fake = $null
$proof = [ordered]@{
    native = $true; status = 'failed'
    method = 'ordinary Windows user token against non-elevated native service'
    accountDeleted = $false; profileDeleted = $false; fixtureDeleted = $false
}
function Start-Probe([string]$File, [string]$Arguments, [bool]$OtherUser) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $File
    $start.Arguments = $Arguments
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.WorkingDirectory = $fixtureRoot
    if ($OtherUser) {
        $start.UserName = $accountName
        $start.Domain = $env:COMPUTERNAME
        $start.Password = $password
        $start.LoadUserProfile = $true
    }
    return [Diagnostics.Process]::Start($start)
}
function Invoke-Helper($Request, [bool]$OtherUser = $false) {
    $child = Start-Probe $helper '' $OtherUser
    try {
        $child.StandardInput.WriteLine(($Request | ConvertTo-Json -Compress))
        $child.StandardInput.Close()
        if (-not $child.WaitForExit(15000)) {
            $child.Kill()
            throw 'Native IPC probe timed out.'
        }
        return ($child.StandardOutput.ReadToEnd() | ConvertFrom-Json)
    } finally { $child.Dispose() }
}
try {
    $proof.step = 'fixture'
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetOwner($identity.User)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl',
            'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),
        'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $fixtureRoot -AclObject $security
    $helper = Join-Path $fixtureRoot 'windows-native.exe'
    Copy-Item -LiteralPath $HelperPath -Destination $helper
    $proof.helperSha256 = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLower()
    $proof.step = 'temporary-standard-user'
    $account = New-LocalUser -Name $accountName -Password $password `
        -Description 'Authorized temporary W03 IPC verification' `
        -AccountExpires (Get-Date).AddHours(1)
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $accountName
    $other = Invoke-Helper @{operation='identity'} $true
    $proof.otherUserToken = $other.sid -eq $account.SID.Value
    $request = @{
        operation='pipe-call'; name=$PipeName; timeout=5000
        bytes=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(
            '{"action":"status"}' + "`n"))
    }
    $same = Invoke-Helper $request
    $proof.sameUserConnected = -not $same.error -and [bool]$same.bytes
    $denied = Invoke-Helper $request $true
    $proof.otherUserDenied = $denied.error -eq 'service-denied'
    $proof.step = 'impostor-server'
    # The deliberately permissive test server checks client SID validation.
    # It receives only a non-secret marker and is never a product listener.
    $fakeName = 'gcr-service-v1-' + $fixtureId + $fixtureId
    $fakeScript = Join-Path $fixtureRoot 'fake-server.ps1'
    @'
param([string]$Name)
$ErrorActionPreference = 'Stop'
$security = [IO.Pipes.PipeSecurity]::new()
$security.AddAccessRule([IO.Pipes.PipeAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
    [IO.Pipes.PipeAccessRights]::FullControl, 'Allow'))
$pipe = [IO.Pipes.NamedPipeServerStream]::new($Name,
    [IO.Pipes.PipeDirection]::InOut, 1,
    [IO.Pipes.PipeTransmissionMode]::Byte,
    [IO.Pipes.PipeOptions]::Asynchronous, 4096, 4096, $security)
try {
    [Console]::Out.WriteLine('ready')
    $pending = $pipe.BeginWaitForConnection($null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(10000)) { throw 'No probe client.' }
    $pipe.EndWaitForConnection($pending)
    $bytes = New-Object byte[] 4096
    $read = $pipe.BeginRead($bytes, 0, $bytes.Length, $null, $null)
    if (-not $read.AsyncWaitHandle.WaitOne(10000)) { throw 'Probe did not close.' }
    [Console]::Out.WriteLine($pipe.EndRead($read))
} finally { $pipe.Dispose() }
'@ | Set-Content -LiteralPath $fakeScript -Encoding UTF8
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $fake = Start-Probe $powershell (
        '-NoProfile -ExecutionPolicy RemoteSigned -File "' + $fakeScript + '" -Name ' + $fakeName
    ) $true
    $ready = $fake.StandardOutput.ReadLineAsync()
    if (-not $ready.Wait(15000) -or $ready.Result -ne 'ready') {
        throw 'Impostor fixture did not become ready.'
    }
    $request.name = $fakeName
    $impostor = Invoke-Helper $request
    if (-not $fake.WaitForExit(15000)) { throw 'Impostor fixture did not exit.' }
    $proof.impostorDenied = $impostor.error -eq 'service-denied'
    $proof.impostorReceivedNoRequest = $fake.StandardOutput.ReadToEnd().Trim() -eq '0'
    if ($proof.otherUserToken -and $proof.sameUserConnected -and
        $proof.otherUserDenied -and $proof.impostorDenied -and
        $proof.impostorReceivedNoRequest) { $proof.status = 'passed' }
} catch {
    $proof.failureType = $_.Exception.GetType().FullName
    $proof.failure = $_.Exception.Message
} finally {
    if ($fake) {
        if (-not $fake.HasExited) { $fake.Kill(); $fake.WaitForExit() }
        $fake.Dispose()
    }
    if ($account) {
        foreach ($profile in @(Get-CimInstance Win32_UserProfile |
            Where-Object { $_.SID -eq $account.SID.Value })) {
            $profilePath = [IO.Path]::GetFullPath($profile.LocalPath)
            if ($profile.Special -or -not $profilePath.StartsWith(
                ('C:\Users\' + $accountName),
                [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Refusing unrelated profile cleanup.'
            }
            $profile | Remove-CimInstance
        }
        $proof.profileDeleted = -not (Get-CimInstance Win32_UserProfile |
            Where-Object { $_.SID -eq $account.SID.Value })
        Remove-LocalUser -SID $account.SID
        $proof.accountDeleted = -not (Get-LocalUser |
            Where-Object { $_.SID -eq $account.SID })
    }
    [Array]::Clear($random, 0, $random.Length)
    $password.Dispose()
    if (Test-Path -LiteralPath $fixtureFull) {
        if ((Get-Item -LiteralPath $fixtureFull).Attributes -band
            [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected reparse root.' }
        Remove-Item -LiteralPath $fixtureFull -Recurse -Force
    }
    $proof.fixtureDeleted = -not (Test-Path -LiteralPath $fixtureFull)
    $proof | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $EvidencePath `
        -Encoding UTF8
}
