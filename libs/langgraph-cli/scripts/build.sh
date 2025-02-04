#!/bin/bash
set -e # Exit on error
set -x # Print commands before execution

rm -rf dist
tsc --outDir dist

mv dist/src/* dist
rm -rf dist/src dist/tests