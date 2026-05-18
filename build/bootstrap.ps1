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
    [string]$ModelTier = "auto",        # auto | medium | large-v3-turbo
    [switch]$SkipModelDownload,
    [switch]$SkipFfmpegBundle,
    [switch]$SkipCudaRuntime
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$script:BootstrapLogDir = $LogDir
$script:TranscriptStarted = $false
$script:LogPath = $null

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
    $header | Out-File -FilePath $script:LogPath -Encoding utf8 -Force
    Start-Transcript -Path $script:LogPath -Append -Force | Out-Null
    $script:TranscriptStarted = $true
}

function Stop-BootstrapLog {
    if ($script:TranscriptStarted) {
        try { Stop-Transcript | Out-Null } catch {}
    }
}

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    [warn] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "    [err] $msg" -ForegroundColor Red }

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

function Test-CudaRuntimeReady {
    $dirs = @()
    if ($env:LOCALAPPDATA) {
        $dirs += (Join-Path $env:LOCALAPPDATA "DiveEdit\cuda")
    }
    if ($InstallDir) {
        $dirs += (Join-Path $InstallDir "cuda")
    }
    foreach ($d in $dirs) {
        if ((Test-Path (Join-Path $d "cudart64_12.dll")) -and
            (Test-Path (Join-Path $d "cudnn_ops64_9.dll"))) {
            return $true
        }
    }
    return $false
}

function Detect-ModelTier {
    if ($script:ModelTier -ne "auto") { return $script:ModelTier }

    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if (-not $smi) {
        Write-Warn2 "no NVIDIA GPU detected - using CPU model 'medium'"
        return "medium"
    }

    try {
        $vramMb = [int](nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | Select-Object -First 1)
        Write-Ok "GPU VRAM: ${vramMb}MB"
    } catch {
        Write-Warn2 "nvidia-smi failed - using CPU model 'medium'"
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
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
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

    if (Test-Path (Join-Path $modelDir "snapshots")) {
        $snap = Get-ChildItem -Path (Join-Path $modelDir "snapshots") -Directory | Select-Object -First 1
        if ($snap -and (Test-Path (Join-Path $snap.FullName "model.bin"))) {
            Write-Ok "$repo already cached"
            return
        }
    }

    Write-Step "downloading $repo to HuggingFace cache"
    New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null

    $appExe = Join-Path $InstallDir "DiveEdit.exe"
    if (Test-Path $appExe) {
        & $appExe --download-model $repo
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "$repo ready"
            return
        }
        Write-Warn2 "bundled downloader failed; trying fallback paths"
    }

    $helper = Join-Path $PSScriptRoot "download_model.py"
    $sysPy = Get-Command python -ErrorAction SilentlyContinue
    if ($sysPy -and (Test-Path $helper)) {
        & $sysPy.Source $helper $repo
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "$repo ready"
            return
        }
        Write-Warn2 "system Python downloader failed; trying direct HTTPS fallback"
    }

    Download-WhisperModelDirect $repo $modelDir
    Write-Ok "$repo ready"
}

function Download-WhisperModelDirect($repo, $modelDir) {
    $files = @("config.json", "model.bin", "tokenizer.json", "vocabulary.txt", "preprocessor_config.json")
    $base = "https://huggingface.co/$repo/resolve/main"
    $snapDir = Join-Path $modelDir "snapshots\main"
    New-Item -ItemType Directory -Force -Path $snapDir | Out-Null

    foreach ($f in $files) {
        $url = "$base/$f"
        $out = Join-Path $snapDir $f
        try {
            Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
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

    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if (-not $smi) {
        Write-Ok "no NVIDIA GPU detected - skipping CUDA runtime"
        return
    }

    $cudaDir = Join-Path $env:LOCALAPPDATA "DiveEdit\cuda"
    $marker = Join-Path $cudaDir "cudart64_12.dll"
    $cudnnMarker = Join-Path $cudaDir "cudnn_ops64_9.dll"
    if ((Test-Path $marker) -and (Test-Path $cudnnMarker)) {
        Write-Ok "CUDA + cuDNN runtime already cached at $cudaDir"
        return
    }

    Write-Step "downloading CUDA 12 + cuDNN 9 runtime DLLs (~1.3GB, one-time)"
    New-Item -ItemType Directory -Force -Path $cudaDir | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue

    $packages = @(
        "nvidia-cuda-runtime-cu12",
        "nvidia-cublas-cu12",
        "nvidia-cuda-nvrtc-cu12",
        "nvidia-nvjitlink-cu12",
        "nvidia-cudnn-cu12"
    )

    foreach ($pkg in $packages) {
        try {
            $api = "https://pypi.org/pypi/$pkg/json"
            $meta = Invoke-RestMethod -Uri $api -UseBasicParsing -TimeoutSec 30
            $latestVersion = ($meta.releases.PSObject.Properties.Name |
                Sort-Object { try { [version]$_ } catch { [version]"0.0.0" } } -Descending |
                Select-Object -First 1)
            $candidates = $meta.releases.$latestVersion |
                Where-Object { $_.filename -like "*win_amd64.whl" }
            if (-not $candidates) {
                Write-Warn2 "  $pkg has no win_amd64 wheel - skipping"
                continue
            }
            $url = $candidates[0].url
            $size = [math]::Round($candidates[0].size / 1MB, 1)
            Write-Ok "  $pkg $latestVersion (${size}MB)"
            $whl = Join-Path $env:TEMP "$pkg.whl"
            Invoke-WebRequest -Uri $url -OutFile $whl -UseBasicParsing -TimeoutSec 600

            $extractDir = Join-Path $env:TEMP "extract_$pkg"
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

    if ((Test-Path $marker) -and (Test-Path $cudnnMarker)) {
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

    Write-Step "DiveEdit post-install bootstrap"
    Write-Ok "install dir: $InstallDir"
    Write-Ok "log file: $script:LogPath"
    Write-Ok "customer machine does not need Python or a virtual environment"

    Ensure-Ffmpeg
    Check-OneOCR
    Download-CudaRuntime

    $tier = Detect-ModelTier
    Write-Ok "selected whisper tier: $tier"
    Download-WhisperModel $tier

    Write-Step "bootstrap done - DiveEdit ready to launch"
} catch {
    $exitCode = 1
    Write-Err "bootstrap failed: $($_.Exception.Message)"
    Write-Err "log file: $script:LogPath"
} finally {
    Stop-BootstrapLog
}

exit $exitCode
