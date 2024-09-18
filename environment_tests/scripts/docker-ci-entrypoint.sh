#!/usr/bin/env bash

set -euxo pipefail

export CI=true

# enable extended globbing for omitting build artifacts
shopt -s extglob

# avoid copying build artifacts from the host
cp -r ../package/!(node_modules|dist|dist-cjs|dist-esm|build|.next|.turbo) .
cp -f ../package/.eslintrc.json .

mkdir -p ./libs/langgraph/
mkdir -p ./libs/checkpoint/

cp -r ../langgraph ./libs/
cp -r ../checkpoint ./libs/

# copy cache
mkdir -p ./.yarn
cp -r ../root/.yarn/!(berry|cache) ./.yarn
cp ../root/yarn.lock ../root/.yarnrc.yml .

yarn plugin import workspace-tools
yarn workspaces focus --production

# Check the build command completes successfully
yarn build

# Check the test command completes successfully
yarn test
