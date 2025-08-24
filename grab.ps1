$dest = "D:\.competitions\aic2025\dataset"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

Get-Content "urls.txt" | ForEach-Object {
    $u = $_.Trim()
    if ([string]::IsNullOrWhiteSpace($u) -or $u.StartsWith("#")) { return }
    if ($u.StartsWith("//")) { $u = "https:$u" }

    $name = Split-Path $u -Leaf
    $zip  = Join-Path $dest $name

    Write-Host "=== Downloading: $u"
    Invoke-WebRequest -Uri $u -OutFile $zip

    Write-Host "=== Unzipping: $zip"
    Expand-Archive -Path $zip -DestinationPath $dest -Force

    Write-Host "=== Removing: $zip"
    Remove-Item $zip -Force
}

Write-Host "All done -> $dest"
