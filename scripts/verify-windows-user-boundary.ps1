param(
    [Parameter(Mandatory = $true)][string]$EvidencePath,
    [Parameter(Mandatory = $true)][string]$HelperPath
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'This temporary-account test requires elevation; the product does not.'
}
$fixtureId = [guid]::NewGuid().ToString('N')
$accountName = 'GcrW01' + $fixtureId.Substring(0, 10)
$fixtureRoot = Join-Path $env:PUBLIC ('cd-w01-' + $fixtureId)
$fixtureFull = [IO.Path]::GetFullPath($fixtureRoot)
$publicFull = [IO.Path]::GetFullPath($env:PUBLIC).TrimEnd('\') + '\'
if (-not $fixtureFull.StartsWith($publicFull,
    [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid fixture root.' }
$secret = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($secret)
$password = ConvertTo-SecureString (
    [Convert]::ToBase64String($secret) + 'aA!7'
) -AsPlainText -Force
$credentialReference = 'w01-' + $fixtureId
$service = 'com.commitdefender.local-knowledge.v1'
$account = $null
$helper = $null
$proof = [ordered]@{
    native = $true; os = [Environment]::OSVersion.VersionString
    method = 'temporary standard user with native logon'
    status = 'failed'; accountDeleted = $false; profileDeleted = $false
    credentialDeleted = $false; fixtureDeleted = $false
}
function Invoke-Helper($Request, [bool]$OtherUser = $false) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $helper
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
    $child = [Diagnostics.Process]::Start($start)
    try {
        $child.StandardInput.WriteLine(($Request | ConvertTo-Json -Compress))
        $child.StandardInput.Close()
        if (-not $child.WaitForExit(15000)) {
            $child.Kill()
            throw 'Native boundary fixture timed out.'
        }
        return ($child.StandardOutput.ReadToEnd() | ConvertFrom-Json)
    } finally { $child.Dispose() }
}
try {
    $proof.step = 'public-fixture'
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetOwner($identity.User)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl',
            'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $security.AddAccessRule($rule)
    }
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),
        'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $fixtureRoot -AclObject $security
    $helper = Join-Path $fixtureRoot 'windows-native.exe'
    Copy-Item -LiteralPath $HelperPath -Destination $helper
    $proof.step = 'create-standard-user'
    $account = New-LocalUser -Name $accountName -Password $password `
        -Description 'Temporary authorized W01 security verification' `
        -AccountExpires (Get-Date).AddHours(1)
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $accountName
    $proof.step = 'private-directory'
    $target = Join-Path $fixtureRoot 'private'
    $created = Invoke-Helper @{operation='directory';path=$target}
    if ($created.error) { throw 'Private directory creation failed.' }
    $file = Join-Path $target 'fixture'
    $proof.step = 'private-publish'
    $published = Invoke-Helper @{
        operation='publish';path=$file;bytes=[Convert]::ToBase64String($secret)
    }
    if (-not $published.published) { throw 'Private fixture creation failed.' }
    $proof.step = 'credential-write'
    $written = Invoke-Helper @{
        operation='credential';action='write';service=$service
        reference=$credentialReference;bytes=[Convert]::ToBase64String($secret)
    }
    if ($written.error) { throw 'Fixture credential creation failed.' }
    $proof.step = 'other-user-logon'
    $otherIdentity = Invoke-Helper @{operation='identity'} $true
    $proof.otherUserToken = $otherIdentity.sid -eq $account.SID.Value
    $read = Invoke-Helper @{operation='read';path=$file;maximum=1024} $true
    $write = Invoke-Helper @{
        operation='publish';path=(Join-Path $target 'other');bytes='eA=='
    } $true
    $credential = Invoke-Helper @{
        operation='credential';action='read';service=$service
        reference=$credentialReference
    } $true
    $proof.privateReadDenied = $read.error -eq 'insecure-storage'
    $proof.privateWriteDenied = $write.error -eq 'insecure-storage'
    $proof.credentialNotVisible = $credential.missing -eq $true
    if ($proof.otherUserToken -and $proof.privateReadDenied -and
        $proof.privateWriteDenied -and $proof.credentialNotVisible) {
        $proof.status = 'passed'
    }
} catch {
    $proof.failureType = $_.Exception.GetType().FullName
    $proof.failure = $_.Exception.Message
}
finally {
    if ($helper -and (Test-Path -LiteralPath $helper)) {
        $removed = Invoke-Helper @{
            operation='credential';action='remove';service=$service
            reference=$credentialReference
        }
        $proof.credentialDeleted = -not $removed.error
    }
    if ($account) {
        $profiles = Get-CimInstance Win32_UserProfile |
            Where-Object { $_.SID -eq $account.SID.Value }
        foreach ($profile in $profiles) {
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
    [Array]::Clear($secret, 0, $secret.Length)
    $password.Dispose()
    if (Test-Path -LiteralPath $fixtureFull) {
        Remove-Item -LiteralPath $fixtureFull -Recurse -Force
    }
    $proof.fixtureDeleted = -not (Test-Path -LiteralPath $fixtureFull)
    $proof | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $EvidencePath `
        -Encoding UTF8
}
