# DiveEdit installer bootstrap.
#
# Runs during installation from build/installer.iss. The installed app is a
# PyInstaller onedir bundle, so customer machines do not need system Python or
# a virtual environment. Python dependencies are already inside DiveEdit.exe's
# runtime; this script only prepares external assets: ffmpeg, CUDA runtime, and
# the faster-whisper model cache.

param(
    [Parameter(Mandatory=$true)]
    [string]$InstallDir,

    [string]$LogDir = "",
    [string]$StatusPath = "",
    [string]$ModelTier = "auto",        # auto | medium | large-v3-turbo
    [switch]$SkipModelDownload,
    [switch]$SkipFfmpegBundle,
    [switch]$SkipCudaRuntime
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$script:BootstrapLogDir = $LogDir
$script:StatusPath = $StatusPath
$script:ProgressPath = if ([string]::IsNullOrWhiteSpace($StatusPath)) { "" } else { "$StatusPath.progress" }
$script:LogPath = $null
$script:MinWhisperGpuVramMb = 4096

function Start-BootstrapLog {
    if ([string]::IsNullOrWhiteSpace($script:BootstrapLogDir)) {
        $script:BootstrapLogDir = Join-Path $env:LOCALAPPDATA "DiveEdit\logs"
    }
    New-Item -ItemType Directory -Force -Path $script:BootstrapLogDir | Out-Null
    $script:LogPath = Join-Path $script:BootstrapLogDir "setup-bootstrap.log"

    $header = @(
        "==== DiveEdit setup bootstrap ====",
        "started: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')",
        "install_dir: $InstallDir",
        "powershell: $($PSVersionTable.PSVersion)",
        "process_id: $PID",
        ""
    )
    [System.IO.File]::WriteAllLines($script:LogPath, $header, [System.Text.Encoding]::ASCII)
}

function Stop-BootstrapLog {
    if (-not [string]::IsNullOrWhiteSpace($script:LogPath)) {
        try {
            $footer = @("", "finished: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')")
            [System.IO.File]::AppendAllLines($script:LogPath, $footer, [System.Text.Encoding]::ASCII)
        } catch {}
    }
}

function Write-LogLine($msg) {
    if ([string]::IsNullOrWhiteSpace($script:LogPath)) { return }
    try {
        [System.IO.File]::AppendAllText($script:LogPath, "$msg`r`n", [System.Text.Encoding]::ASCII)
    } catch {}
}

function Write-Status($msg) {
    if ([string]::IsNullOrWhiteSpace($script:StatusPath)) { return }
    try {
        [System.IO.File]::WriteAllText($script:StatusPath, $msg, [System.Text.Encoding]::ASCII)
    } catch {}
}

function Write-ProgressValue($percent) {
    if ([string]::IsNullOrWhiteSpace($script:ProgressPath)) { return }
    try {
        $value = [Math]::Max(0, [Math]::Min(100, [int]$percent))
        [System.IO.File]::WriteAllText($script:ProgressPath, [string]$value, [System.Text.Encoding]::ASCII)
    } catch {}
}

function Write-ProgressStatus($percent, $msg) {
    Write-ProgressValue $percent
    Write-Status $msg
}

function Write-Step($msg) {
    Write-Status $msg
    Write-LogLine "==> $msg"
    Write-Host "==> $msg" -ForegroundColor Cyan
}
function Write-Ok($msg) {
    Write-Status $msg
    Write-LogLine "    [ok] $msg"
    Write-Host "    [ok] $msg" -ForegroundColor Green
}
function Write-Warn2($msg) {
    Write-Status $msg
    Write-LogLine "    [warn] $msg"
    Write-Host "    [warn] $msg" -ForegroundColor Yellow
}
function Write-Err($msg) {
    Write-Status $msg
    Write-LogLine "    [err] $msg"
    Write-Host "    [err] $msg" -ForegroundColor Red
}

function Invoke-DownloadFile($url, $out, $timeoutSec = 600) {
    $lastError = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Invoke-DownloadFileOnce $url $out $timeoutSec $attempt
            return
        } catch {
            $lastError = $_.Exception.Message
            Write-Warn2 "download attempt $attempt failed: $lastError"
            if ($attempt -lt 3) {
                Write-Status "download retry $($attempt + 1)/3..."
                Start-Sleep -Seconds 2
            }
        }
    }
    throw "download failed after 3 attempts: $lastError"
}

function Invoke-DownloadFileOnce($url, $out, $timeoutSec = 600, $attempt = 1) {
    $tmp = "$out.part"
    if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Force }
    if (Test-Path $out) { Remove-Item -LiteralPath $out -Force }

    Write-ProgressStatus 0 "connecting to download source (attempt $attempt/3)..."
    Write-LogLine "    downloading $url"

    $request = [System.Net.HttpWebRequest]::Create($url)
    $request.Timeout = [Math]::Max(30, $timeoutSec) * 1000
    $request.ReadWriteTimeout = 60000
    $request.UserAgent = "DiveEdit-Setup"
    $response = $null
    $inputStream = $null
    $fileStream = $null
    try {
        $response = $request.GetResponse()
        $inputStream = $response.GetResponseStream()
        if ($inputStream -and $inputStream.CanTimeout) {
            $inputStream.ReadTimeout = 30000
        }
        $fileStream = [System.IO.File]::Open($tmp, [System.IO.FileMode]::CreateNew)
        $buffer = New-Object byte[] (1024 * 1024)
        $totalBytes = [int64]$response.ContentLength
        $downloadedBytes = [int64]0
        $nextPercent = 0
        $nextMb = 50
        $startedAt = [DateTime]::UtcNow
        while ($true) {
            if ((([DateTime]::UtcNow - $startedAt).TotalSeconds) -gt $timeoutSec) {
                throw "download exceeded ${timeoutSec}s"
            }
            $read = $inputStream.Read($buffer, 0, $buffer.Length)
            if ($read -le 0) { break }
            $fileStream.Write($buffer, 0, $read)
            $downloadedBytes += [int64]$read
            if ($totalBytes -gt 0) {
                $percent = [int][Math]::Floor(($downloadedBytes * 100.0) / $totalBytes)
                if ($percent -ge $nextPercent) {
                    $doneMb = [Math]::Round($downloadedBytes / 1MB, 1)
                    $totalMb = [Math]::Round($totalBytes / 1MB, 1)
                    $line = "download {0}% ({1}/{2} MB)" -f $percent, $doneMb, $totalMb
                    Write-ProgressStatus $percent $line
                    Write-LogLine "    $line"
                    Write-Host "    $line" -ForegroundColor DarkCyan
                    $nextPercent = [Math]::Min(100, $percent + 5)
                }
            } else {
                $doneMb = [Math]::Round($downloadedBytes / 1MB, 1)
                if ($doneMb -ge $nextMb) {
                    $line = "download {0} MB" -f $doneMb
                    Write-Status $line
                    Write-LogLine "    $line"
                    Write-Host "    $line" -ForegroundColor DarkCyan
                    $nextMb += 50
                }
            }
        }
    } finally {
        if ($fileStream) { $fileStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Dispose() }
    }

    $item = Get-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
    if (-not $item -or $item.Length -le 0) {
        if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Force }
        throw "download produced an empty file"
    }
    Move-Item -LiteralPath $tmp -Destination $out -Force
}

function ConvertTo-ProcessArgumentString([string[]]$argList) {
    $parts = @()
    foreach ($arg in $argList) {
        if ($null -eq $arg) { continue }
        $value = [string]$arg
        if ($value -match '[\s"]') {
            $value = '"' + ($value -replace '"', '\"') + '"'
        }
        $parts += $value
    }
    return ($parts -join " ")
}

function Invoke-ProcessWithTimeout($exe, [string[]]$argList, $timeoutSec = 3600) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = ConvertTo-ProcessArgumentString $argList
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    if (-not $p.Start()) {
        throw "process did not start: $exe"
    }
    if (-not $p.WaitForExit([Math]::Max(30, $timeoutSec) * 1000)) {
        try { $p.Kill() } catch {}
        throw "process timed out after ${timeoutSec}s: $exe"
    }
    return $p.ExitCode
}

function Get-FreeGbForPath($path) {
    try {
        $root = [System.IO.Path]::GetPathRoot($path)
        if ([string]::IsNullOrWhiteSpace($root)) { return $null }
        $drive = New-Object System.IO.DriveInfo($root)
        return [math]::Round($drive.AvailableFreeSpace / 1GB, 1)
    } catch {
        return $null
    }
}

function Resolve-NvidiaSmiPath {
    $cmd = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) {
        return $cmd.Source
    }

    $candidates = @(
        (Join-Path $env:WINDIR "Sysnative\nvidia-smi.exe"),
        (Join-Path $env:WINDIR "System32\nvidia-smi.exe"),
        "C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Get-PrimaryGpuVramMb {
    $smi = Resolve-NvidiaSmiPath
    if (-not $smi) { return $null }
    try {
        $raw = & $smi --query-gpu=memory.total --format=csv,noheader,nounits | Select-Object -First 1
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return [int]$raw
    } catch {
        return $null
    }
}

function Test-WhisperGpuEligible {
    $vramMb = Get-PrimaryGpuVramMb
    if ($null -eq $vramMb) {
        return $false
    }
    return $vramMb -ge $script:MinWhisperGpuVramMb
}

function Check-DiskSpaceNotice {
    $vramMb = Get-PrimaryGpuVramMb
    $gpuEligible = ($null -ne $vramMb) -and ($vramMb -ge $script:MinWhisperGpuVramMb)
    $needsGpuAssets = $gpuEligible -and (-not $SkipCudaRuntime)
    $recommendedGb = if ($needsGpuAssets) { 10.0 } else { 6.0 }
    $cacheRoot = Join-Path $env:USERPROFILE ".cache\huggingface\hub"
    $localRoot = Join-Path $env:LOCALAPPDATA "DiveEdit"
    $paths = @($InstallDir, $env:TEMP, $cacheRoot, $localRoot) | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_)
    }

    Write-Step "disk space check"
    Write-Ok "recommended free space: ${recommendedGb}GB minimum"
    if ($needsGpuAssets) {
        Write-Ok "eligible NVIDIA GPU detected (${vramMb}MB VRAM): CUDA/cuDNN runtime and Whisper model may be downloaded"
    } elseif ($gpuEligible) {
        Write-Warn2 "eligible NVIDIA GPU detected (${vramMb}MB VRAM), but CUDA runtime preparation is skipped"
    } elseif ($null -ne $vramMb) {
        Write-Ok "NVIDIA GPU has ${vramMb}MB VRAM; below ${script:MinWhisperGpuVramMb}MB minimum, using CPU setup"
    } else {
        Write-Ok "CPU setup: Whisper model and ffmpeg assets may be downloaded"
    }

    $seen = @{}
    foreach ($p in $paths) {
        try {
            $root = [System.IO.Path]::GetPathRoot($p)
        } catch {
            continue
        }
        if ([string]::IsNullOrWhiteSpace($root) -or $seen.ContainsKey($root)) { continue }
        $seen[$root] = $true
        $freeGb = Get-FreeGbForPath $p
        if ($null -eq $freeGb) {
            Write-Warn2 "could not check free space for $root"
        } elseif ($freeGb -lt $recommendedGb) {
            Write-Warn2 "$root has ${freeGb}GB free; recommended minimum is ${recommendedGb}GB"
        } else {
            Write-Ok "$root free space: ${freeGb}GB"
        }
    }
}

function Resolve-ModelRepo($tier) {
    switch ($tier) {
        "large-v3-turbo" { return "mobiuslabsgmbh/faster-whisper-large-v3-turbo" }
        "turbo"          { return "mobiuslabsgmbh/faster-whisper-large-v3-turbo" }
        "medium"         { return "Systran/faster-whisper-medium" }
        "large-v3"       { return "Systran/faster-whisper-large-v3" }
        "small"          { return "Systran/faster-whisper-small" }
        default {
            if ($tier -like "*/*") { return $tier }
            return "Systran/faster-whisper-$tier"
        }
    }
}

function Test-WhisperSnapshotReady($snapDir) {
    $required = @("model.bin", "config.json")
    foreach ($f in $required) {
        $path = Join-Path $snapDir $f
        $item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
        if (-not $item -or $item.Length -le 0) { return $false }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            return $false
        }
    }

    $tokenizerFiles = @("tokenizer.json", "vocabulary.json", "vocabulary.txt")
    foreach ($f in $tokenizerFiles) {
        $path = Join-Path $snapDir $f
        $item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
        if ($item -and $item.Length -gt 0 -and (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0)) {
            return $true
        }
    }
    return $false
}

function Test-WhisperModelReady($modelDir) {
    $snapRoot = Join-Path $modelDir "snapshots"
    if (-not (Test-Path $snapRoot)) { return $false }
    $snaps = Get-ChildItem -Path $snapRoot -Directory -ErrorAction SilentlyContinue
    foreach ($snap in $snaps) {
        if (Test-WhisperSnapshotReady $snap.FullName) { return $true }
    }
    return $false
}

function Test-CudaRuntimeReady {
    $expectedRuntime = Get-CudaRuntimeVersionStamp
    $dirs = @()
    if ($env:LOCALAPPDATA) {
        $dirs += (Join-Path $env:LOCALAPPDATA "DiveEdit\cuda")
    }
    if ($InstallDir) {
        $dirs += (Join-Path $InstallDir "cuda")
    }
    foreach ($d in $dirs) {
        if ((Test-CudaRuntimeDllSetReady $d) -and
            ((Get-CudaRuntimeVersionStampFromDir $d) -eq $expectedRuntime)) {
            return $true
        }
    }
    return $false
}

function Get-CudaRuntimePackages {
    return @(
        @{ Name = "nvidia-cuda-runtime-cu12"; Version = "12.3.101" },
        @{ Name = "nvidia-cublas-cu12"; Version = "12.3.4.1" },
        @{ Name = "nvidia-cuda-nvrtc-cu12"; Version = "12.3.107" },
        @{ Name = "nvidia-nvjitlink-cu12"; Version = "12.3.101" },
        @{ Name = "nvidia-cudnn-cu12"; Version = "9.1.0.70" }
    )
}

function Get-CudaRuntimeVersionStamp {
    return ((Get-CudaRuntimePackages) | ForEach-Object { "$($_.Name)==$($_.Version)" }) -join "`n"
}

function Get-CudaRuntimeVersionStampFromDir($dir) {
    $versionFile = Join-Path $dir "runtime-version.txt"
    if (-not (Test-Path $versionFile)) { return "" }
    return (Get-Content -Raw -LiteralPath $versionFile).Trim()
}

function Test-CudaRuntimeDllSetReady($dir) {
    $required = @(
        "cudart64_12.dll",
        "cublas64_12.dll",
        "cublasLt64_12.dll",
        "cudnn64_9.dll",
        "cudnn_ops64_9.dll",
        "cudnn_cnn64_9.dll",
        "cudnn_graph64_9.dll"
    )
    foreach ($dll in $required) {
        if (-not (Test-Path (Join-Path $dir $dll))) { return $false }
    }
    if (-not (Get-ChildItem -Path $dir -Filter "nvrtc64_*.dll" -ErrorAction SilentlyContinue | Select-Object -First 1)) {
        return $false
    }
    if (-not (Get-ChildItem -Path $dir -Filter "nvJitLink_*.dll" -ErrorAction SilentlyContinue | Select-Object -First 1)) {
        return $false
    }
    return $true
}

function Detect-ModelTier {
    if ($script:ModelTier -ne "auto") { return $script:ModelTier }

    $vramMb = Get-PrimaryGpuVramMb
    if ($null -eq $vramMb) {
        Write-Warn2 "no NVIDIA GPU detected - using CPU model 'medium'"
        return "medium"
    }

    Write-Ok "GPU VRAM: ${vramMb}MB"
    if ($vramMb -lt $script:MinWhisperGpuVramMb) {
        Write-Warn2 "GPU VRAM below ${script:MinWhisperGpuVramMb}MB minimum - using CPU model 'medium'"
        return "medium"
    }

    if (Test-CudaRuntimeReady) {
        return "large-v3-turbo"
    }

    Write-Warn2 "CUDA runtime is not ready - using CPU model 'medium'"
    return "medium"
}

function Ensure-Ffmpeg {
    $ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($ff) {
        Write-Ok "ffmpeg already on PATH: $($ff.Source)"
        return
    }
    if ($SkipFfmpegBundle) {
        Write-Warn2 "ffmpeg missing; -SkipFfmpegBundle set"
        return
    }

    $bundled = Join-Path $InstallDir "bin\ffmpeg.exe"
    if (Test-Path $bundled) {
        Write-Ok "using bundled ffmpeg at $bundled"
        return
    }

    Write-Step "downloading ffmpeg essentials build (~50MB)"
    $url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    $tmp = Join-Path $env:TEMP "ffmpeg.zip"
    Invoke-DownloadFile $url $tmp 600
    $extract = Join-Path $env:TEMP "ffmpeg-extract"
    if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
    Expand-Archive -Path $tmp -DestinationPath $extract -Force
    $exe = Get-ChildItem -Path $extract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    if (-not $exe) { throw "ffmpeg.exe not found in archive" }

    $binDir = Join-Path $InstallDir "bin"
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    Copy-Item $exe.FullName $bundled -Force
    Get-ChildItem -Path $extract -Recurse -Filter "ffprobe.exe" | Select-Object -First 1 | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $binDir "ffprobe.exe") -Force
    }

    Remove-Item $tmp -Force
    Remove-Item -Recurse -Force $extract
    Write-Ok "ffmpeg bundled at $bundled"
}

function Download-WhisperModel($tier) {
    if ($SkipModelDownload) {
        Write-Warn2 "-SkipModelDownload set - skipping ($tier)"
        return
    }

    $repo = Resolve-ModelRepo $tier
    $cacheRoot = Join-Path $env:USERPROFILE ".cache\huggingface\hub"
    $modelDir = Join-Path $cacheRoot ("models--" + $repo.Replace("/", "--"))

    if (Test-WhisperModelReady $modelDir) {
        Write-Ok "$repo already cached"
        return
    } elseif (Test-Path (Join-Path $modelDir "snapshots")) {
        Write-Warn2 "$repo cache exists but is incomplete or link-based; repairing"
    }

    Write-Step "downloading $repo to HuggingFace cache"
    New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null

    $appExe = Join-Path $InstallDir "DiveEdit.exe"
    if (Test-Path $appExe) {
        $code = Invoke-ProcessWithTimeout $appExe @("--download-model", $repo) 3600
        if ($code -eq 0 -and (Test-WhisperModelReady $modelDir)) {
            Write-Ok "$repo ready"
            return
        }
        Write-Warn2 "bundled downloader failed or cache is not usable; trying fallback paths"
    }

    $helper = Join-Path $PSScriptRoot "download_model.py"
    $sysPy = Get-Command python -ErrorAction SilentlyContinue
    if ($sysPy -and (Test-Path $helper)) {
        & $sysPy.Source $helper $repo
        if ($LASTEXITCODE -eq 0 -and (Test-WhisperModelReady $modelDir)) {
            Write-Ok "$repo ready"
            return
        }
        Write-Warn2 "system Python downloader failed or cache is not usable; trying direct HTTPS fallback"
    }

    Download-WhisperModelDirect $repo $modelDir
    if (-not (Test-WhisperModelReady $modelDir)) {
        throw "$repo cache is not usable after download"
    }
    Write-Ok "$repo ready"
}

function Download-WhisperModelDirect($repo, $modelDir) {
    $files = @("config.json", "model.bin", "tokenizer.json", "vocabulary.json", "vocabulary.txt", "preprocessor_config.json")
    $base = "https://huggingface.co/$repo/resolve/main"
    $snapDir = Join-Path $modelDir "snapshots\main"
    New-Item -ItemType Directory -Force -Path $snapDir | Out-Null

    foreach ($f in $files) {
        $url = "$base/$f"
        $out = Join-Path $snapDir $f
        try {
            Invoke-DownloadFile $url $out 900
            Write-Ok "  $f"
        } catch {
            if ($f -eq "vocabulary.txt" -or $f -eq "preprocessor_config.json") {
                Write-Warn2 "  $f missing (optional)"
            } else {
                throw "failed to fetch $f from $repo"
            }
        }
    }
}

function Check-OneOCR {
    $pkg = Get-AppxPackage Microsoft.Windows.Photos -ErrorAction SilentlyContinue
    if ($pkg) {
        Write-Ok "Microsoft Photos installed (OneOCR available)"
    } else {
        Write-Warn2 "Microsoft Photos not installed - OCR may fail. Install Microsoft Photos from Store."
    }
}

function Download-CudaRuntime {
    if ($SkipCudaRuntime) {
        Write-Warn2 "-SkipCudaRuntime set - skipping CUDA runtime"
        return
    }

    $vramMb = Get-PrimaryGpuVramMb
    if ($null -eq $vramMb) {
        Write-Ok "no NVIDIA GPU detected - skipping CUDA runtime"
        return
    }
    if ($vramMb -lt $script:MinWhisperGpuVramMb) {
        Write-Ok "GPU VRAM ${vramMb}MB is below ${script:MinWhisperGpuVramMb}MB minimum - skipping CUDA runtime"
        return
    }

    $cudaDir = Join-Path $env:LOCALAPPDATA "DiveEdit\cuda"
    $marker = Join-Path $cudaDir "cudart64_12.dll"
    $versionFile = Join-Path $cudaDir "runtime-version.txt"
    $expectedRuntime = Get-CudaRuntimeVersionStamp
    if (Test-CudaRuntimeDllSetReady $cudaDir) {
        if ((Get-CudaRuntimeVersionStampFromDir $cudaDir) -eq $expectedRuntime) {
            Write-Ok "CUDA + cuDNN runtime already cached at $cudaDir"
            return
        }
        Write-Warn2 "CUDA cache version mismatch - refreshing pinned runtime"
        Remove-Item -Recurse -Force $cudaDir
    }

    Write-Step "downloading pinned CUDA 12.3 + cuDNN 9 runtime DLLs (~1GB, one-time)"
    New-Item -ItemType Directory -Force -Path $cudaDir | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue

    $packages = Get-CudaRuntimePackages
    foreach ($pkgSpec in $packages) {
        $pkg = $pkgSpec.Name
        $version = $pkgSpec.Version
        try {
            $api = "https://pypi.org/pypi/$pkg/$version/json"
            $meta = Invoke-RestMethod -Uri $api -UseBasicParsing -TimeoutSec 30
            $candidates = $meta.urls | Where-Object { $_.filename -like "*win_amd64.whl" }
            if (-not $candidates) {
                Write-Warn2 "  $pkg $version has no win_amd64 wheel - skipping"
                continue
            }
            $url = $candidates[0].url
            $size = [math]::Round($candidates[0].size / 1MB, 1)
            Write-Ok "  $pkg $version (${size}MB)"
            $whl = Join-Path $env:TEMP "$pkg-$version.whl"
            Invoke-DownloadFile $url $whl 900

            $extractDir = Join-Path $env:TEMP "extract_$pkg-$version"
            if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
            [System.IO.Compression.ZipFile]::ExtractToDirectory($whl, $extractDir)

            $dlls = Get-ChildItem -Path $extractDir -Recurse -Filter "*.dll"
            foreach ($d in $dlls) {
                Copy-Item $d.FullName $cudaDir -Force
            }

            Remove-Item $whl -Force
            Remove-Item -Recurse -Force $extractDir
        } catch {
            Write-Warn2 "  $pkg download failed: $($_.Exception.Message)"
            Write-Warn2 "  GPU acceleration will be unavailable; the app falls back to CPU."
        }
    }

    if (Test-CudaRuntimeDllSetReady $cudaDir) {
        $expectedRuntime | Out-File -FilePath $versionFile -Encoding utf8 -Force
        Write-Ok "CUDA + cuDNN runtime ready at $cudaDir"
    } elseif (Test-Path $marker) {
        Write-Warn2 "CUDA loaded but cuDNN missing - DiveEdit will run on CPU."
    } else {
        Write-Warn2 "CUDA runtime incomplete - DiveEdit will run on CPU."
    }
}

$exitCode = 0
try {
    Start-BootstrapLog
    Write-ProgressStatus 1 "Starting DiveEdit runtime preparation..."

    Write-Step "DiveEdit post-install bootstrap"
    Write-Ok "install dir: $InstallDir"
    Write-Ok "log file: $script:LogPath"
    Write-Ok "customer machine does not need Python or a virtual environment"
    Write-ProgressStatus 5 "Checking disk space and hardware..."
    Check-DiskSpaceNotice

    Write-ProgressStatus 18 "Preparing ffmpeg video tools..."
    Ensure-Ffmpeg
    Write-ProgressStatus 28 "Checking OCR support..."
    Check-OneOCR
    Write-ProgressStatus 35 "Preparing GPU runtime..."
    Download-CudaRuntime

    Write-ProgressStatus 72 "Selecting Whisper speech model..."
    $tier = Detect-ModelTier
    Write-Ok "selected whisper tier: $tier"
    Write-ProgressStatus 78 "Preparing Whisper speech model ($tier)..."
    Download-WhisperModel $tier

    Write-ProgressStatus 100 "DiveEdit runtime is ready."
    Write-Step "bootstrap done - DiveEdit ready to launch"
} catch {
    $exitCode = 1
    Write-Err "bootstrap failed: $($_.Exception.Message)"
    Write-Err "log file: $script:LogPath"
} finally {
    Stop-BootstrapLog
}

exit $exitCode
