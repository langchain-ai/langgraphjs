#!/usr/bin/env python3
"""
Script to configure langgraph.json for different test scenarios.
Usage:
    python configure-langgraph.py --node-version 20
    python configure-langgraph.py --node-version 22 --auth
"""

import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Configure langgraph.json for testing")
    parser.add_argument(
        "--node-version", type=str, required=True, help="Node version (e.g., 20, 22)"
    )
    parser.add_argument(
        "--auth", action="store_true", help="Include auth configuration"
    )
    parser.add_argument(
        "--docker-tag",
        type=str,
        default=None,
        help="Override _INTERNAL_docker_tag (e.g., 20-wolfi)",
    )
    parser.add_argument(
        "--output", type=str, default="langgraph.json", help="Output file path"
    )

    args = parser.parse_args()

    # Base configuration
    config = {
        "node_version": args.node_version,
        "dependencies": ["."],
        "graphs": {
            "agent": {"path": "./agent.mts:graph", "description": "agent"},
            "nested": "./nested.mts:graph",
            "weather": "./weather.mts:graph",
            "error": "./error.mts:graph",
            "delay": "./delay.mts:graph",
            "dynamic": "./dynamic.mts:graph",
            "command": "./command.mts:graph",
            "agent_simple": "./agent_simple.mts:graph",
            "agent_simple_factory": "./agent_simple.mts:graphFactory",
            "factory_store": "./factory_store.mts:graph",
        },
        "env": ".env",
        "http": {
            "app": "./http.mts:app",
            "configurable_headers": {"includes": ["x-configurable-header"]},
        },
        "ui": {"agent-alias": "./agent.ui.tsx"},
    }

    # Override base image tag if requested (e.g., for UBI-9 distro images)
    if args.docker_tag:
        config["_INTERNAL_docker_tag"] = args.docker_tag

    # Add auth configuration if requested
    if args.auth:
        config["auth"] = {"path": "./auth.mts:auth"}

    # Write the configuration
    output_path = Path(args.output)
    with open(output_path, "w") as f:
        json.dump(config, f, indent=2)


if __name__ == "__main__":
    main()
