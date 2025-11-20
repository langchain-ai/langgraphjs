#!/bin/bash

# Script to run validation tests for AgentCore Memory checkpointer with optional test suite filtering
# Usage: ./run-validation-tests.sh [test_suite1] [test_suite2] ...
# Valid test suites: getTuple, list, put, putWrites, deleteThread
# Example: ./run-validation-tests.sh getTuple list

set -e

# Check if .env file exists
if [ ! -f .env ]; then
    echo "❌ .env file not found. Please copy .env.example to .env and configure your AWS settings."
    exit 1
fi

# Load environment variables from .env file
export $(grep -v '^#' .env | xargs)

# Check required environment variables
if [ -z "$AWS_REGION" ] || [ -z "$AGENTCORE_MEMORY_ID" ]; then
    echo "❌ Missing required environment variables"
    exit 1
fi

# Valid test suites
VALID_SUITES=("getTuple" "list" "put" "putWrites" "deleteThread")

# Function to check if a test suite is valid
is_valid_suite() {
    local suite=$1
    for valid in "${VALID_SUITES[@]}"; do
        if [[ "$valid" == "$suite" ]]; then
            return 0
        fi
    done
    return 1
}

# Parse command line arguments for test suite filters
TEST_FILTERS=()
for arg in "$@"; do
    if is_valid_suite "$arg"; then
        TEST_FILTERS+=("$arg")
    else
        echo "❌ Invalid test suite: $arg"
        echo "Valid test suites: ${VALID_SUITES[*]}"
        exit 1
    fi
done

if [ ${#TEST_FILTERS[@]} -eq 0 ]; then
    echo "🧪 Running all validation tests for AgentCore Memory checkpointer..."
else
    echo "🧪 Running validation tests for AgentCore Memory checkpointer (suites: ${TEST_FILTERS[*]})..."
fi

# Build our package first
pnpm build

# Run validation using the CLI directly
node ../checkpoint-validation/bin/cli.js ../checkpoint-validation/src/tests/agentcore_initializer.ts ${TEST_FILTERS[*]}