# Draws the app icon (a car wheel on a blue tile) and writes:
#   installer\carparts.ico   (used by the desktop shortcut)
#   public\icon.png          (used as the window/tab icon)
# Run only if you want to change the icon:  powershell -File installer\make-icon.ps1
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Circle($g, $brush, [double]$cx, [double]$cy, [double]$r) {
  $g.FillEllipse($brush, [single]($cx - $r), [single]($cy - $r), [single](2 * $r), [single](2 * $r))
}

function New-Frame([int]$s) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)

  # rounded blue tile
  $d = $s * 0.44
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($s - $d, 0, $d, $d, 270, 90)
  $path.AddArc($s - $d, $s - $d, $d, $d, 0, 90)
  $path.AddArc(0, $s - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.PointF]::new(0, 0)), ([System.Drawing.PointF]::new($s, $s)), ([System.Drawing.Color]::FromArgb(37, 99, 235)), ([System.Drawing.Color]::FromArgb(30, 58, 138))
  $g.FillPath($bg, $path)

  # wheel: tyre, rim, hub and five bolts
  $c = $s / 2
  $tyre = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(15, 23, 42))
  $rim = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(241, 245, 249))
  $hub = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(100, 116, 139))
  Circle $g $tyre $c $c ($s * 0.36)
  Circle $g $rim $c $c ($s * 0.25)
  Circle $g $hub $c $c ($s * 0.12)
  for ($i = 0; $i -lt 5; $i++) {
    $a = ($i * 72 - 90) * [Math]::PI / 180
    Circle $g $tyre ($c + [Math]::Cos($a) * $s * 0.185) ($c + [Math]::Sin($a) * $s * 0.185) ($s * 0.03)
  }
  Circle $g $rim $c $c ($s * 0.04)
  $g.Dispose()
  return $bmp
}

$sizes = 256, 64, 48, 32, 24, 16
$pngs = foreach ($s in $sizes) {
  $bmp = New-Frame $s
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  if ($s -eq 256) { $bmp.Save((Join-Path $repo 'public\icon.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
  $bmp.Dispose()
  , $ms.ToArray()
}

# .ico container holding the PNG frames
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
$w.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot 'carparts.ico'), $out.ToArray())
Write-Host 'icon written'
