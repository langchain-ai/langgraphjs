Set-PSDebug -Trace 1
$ErrorActionPreference = "Stop"

Remove-Item -Path "dist" -Recurse -Force -ErrorAction SilentlyContinue
tsc --outDir dist

Copy-Item -Path "src/graph/parser/schema/types.template.mts" -Destination "dist/src/graph/parser/schema"
Remove-Item -Path "dist/src/graph/parser/schema/types.template.mjs" -Force -ErrorAction SilentlyContinue

Move-Item -Path "dist/src/*" -Destination "dist"
Remove-Item -Path "dist/src","dist/tests" -Recurse -Force -ErrorAction SilentlyContinue
