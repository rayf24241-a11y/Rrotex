$ErrorActionPreference = 'Stop'

$envPath = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path $envPath)) {
  throw "Missing .env. Copy .env.example to .env, then add your GoDaddy key and secret."
}

Get-Content $envPath | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith('#')) { return }
  $parts = $line -split '=', 2
  if ($parts.Length -eq 2) {
    [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), 'Process')
  }
}

$apiKey = $env:GODADDY_API_KEY
$apiSecret = $env:GODADDY_API_SECRET
$domain = if ($env:GODADDY_DOMAIN) { $env:GODADDY_DOMAIN } else { 'rrotex.com' }

if (-not $apiKey -or $apiKey -eq 'put_your_key_here') {
  throw 'GODADDY_API_KEY is missing in .env.'
}
if (-not $apiSecret -or $apiSecret -eq 'put_your_secret_here') {
  throw 'GODADDY_API_SECRET is missing in .env.'
}

$headers = @{
  Authorization = "sso-key ${apiKey}:${apiSecret}"
  Accept = 'application/json'
  'Content-Type' = 'application/json'
}

function Set-GoDaddyRecord {
  param(
    [string] $Type,
    [string] $Name,
    [object[]] $Records
  )

  $uri = "https://api.godaddy.com/v1/domains/$domain/records/$Type/$Name"
  $body = $Records | ConvertTo-Json -Depth 5
  Invoke-RestMethod -Method Put -Uri $uri -Headers $headers -Body $body | Out-Null
  Write-Host "Set $Type $Name"
}

Set-GoDaddyRecord -Type 'A' -Name '@' -Records @(
  @{ data = '76.76.21.21'; ttl = 600 }
)

Set-GoDaddyRecord -Type 'CNAME' -Name 'www' -Records @(
  @{ data = 'cname.vercel-dns.com'; ttl = 600 }
)

Write-Host ''
Write-Host 'Done. DNS can still take a few minutes to update.'
Write-Host 'Check with: Resolve-DnsName rrotex.com'
