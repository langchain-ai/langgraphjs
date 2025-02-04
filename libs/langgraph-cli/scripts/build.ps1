Set-PSDebug -Trace 1
$ErrorActionPreference = "Stop"

Remove-Item -Path "dist" -Recurse -Force -ErrorAction SilentlyContinue
tsc --outDir dist

Move-Item -Path "dist/src/*" -Destination "dist"
Remove-Item -Path "dist/src","dist/tests" -Recurse -Force -ErrorAction SilentlyContinue
