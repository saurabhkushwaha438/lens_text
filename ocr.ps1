# Windows built-in OCR (WinRT Windows.Media.Ocr) via PowerShell 5.1.
# Called from Electron's main process: reads an image file, writes a JSON
# payload of lines/words with pixel-coordinate bounding rects to stdout.
param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [string]$Lang
)

$ErrorActionPreference = 'Stop'

# Project WinRT namespaces into the AppDomain (PowerShell 5.1 syntax).
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Foundation, ContentType = WindowsRuntime]

Add-Type -AssemblyName System.Runtime.WindowsRuntime

# Bridge WinRT IAsyncOperation<T> -> .NET Task so we can block on it.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($WinRtOperation, [Type]$ResultType) {
  $netTask = $asTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($WinRtOperation))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

try {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $engine = $null
  if ($Lang) {
    try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($Lang))) } catch {}
  }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) { throw 'No OCR language pack installed. Add one in Settings > Time & Language > Language.' }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  # PowerShell 5.1's ConvertTo-Json emits some control characters raw, which
  # breaks JSON.parse on the Node side - strip them at the source.
  $out = [ordered]@{ text = $result.Text; lines = @() }
  foreach ($line in $result.Lines) {
    $words = @()
    foreach ($w in $line.Words) {
      $words += [ordered]@{
        text = $w.Text
        x0   = [double]$w.BoundingRect.X
        y0   = [double]$w.BoundingRect.Y
        x1   = [double]($w.BoundingRect.X + $w.BoundingRect.Width)
        y1   = [double]($w.BoundingRect.Y + $w.BoundingRect.Height)
      }
    }
    $out.lines += , [ordered]@{ text = $line.Text; words = $words }
  }

  [Console]::Out.Write(($out | ConvertTo-Json -Depth 5 -Compress))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
