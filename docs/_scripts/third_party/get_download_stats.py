#!/usr/bin/env python
"""Retrieve download counts for npm packages."""

import argparse
from datetime import datetime
from typing import TypedDict
import pathlib

import requests
import yaml


class Package(TypedDict):
    """A TypedDict representing a package"""

    name: str
    """The name of the package."""
    repo: str
    """Repository ID within github. Format is: [orgname]/[repo_name]."""
    description: str
    """A brief description of what the package does."""


class ResolvedPackage(Package):
    weekly_downloads: int | None


HERE = pathlib.Path(__file__).parent
PACKAGES_FILE = HERE / "packages.yml"
PACKAGES = yaml.safe_load(PACKAGES_FILE.read_text())['packages']


def _get_weekly_downloads(packages: list[Package]) -> list[ResolvedPackage]:
    """Retrieve the weekly download count for a list of npm packages.

    This function checks if the package exists on the npm registry and then,
    if the package was published more than 48 hours ago, it retrieves the
    download statistics for the last week.
    """
    resolved_packages: list[ResolvedPackage] = []

    for package in packages:
        # Check if package exists on the npm registry
        npm_url = f"https://registry.npmjs.org/{package['name']}"
        try:
            npm_response = requests.get(npm_url)
            npm_response.raise_for_status()
        except requests.exceptions.HTTPError:
            raise AssertionError(f"Package {package['name']} does not exist on npm registry")

        npm_data = npm_response.json()

        # Retrieve the first publish date using the 'created' timestamp from the 'time' field.
        created_str = npm_data.get("time", {}).get("created")
        if created_str is None:
            raise AssertionError(f"Package {package['name']} has no creation time in registry data")
        # Remove the trailing 'Z' if present and parse the ISO format timestamp
        first_publish_date = datetime.fromisoformat(created_str.rstrip("Z"))

        # If package was published more than 48 hours ago, fetch download stats.
        if (datetime.now() - first_publish_date).total_seconds() >= 48 * 3600:
            stats_url = f"https://api.npmjs.org/downloads/point/last-week/{package['name']}"
            stats_response = requests.get(stats_url)
            stats_response.raise_for_status()
            stats_data = stats_response.json()
            num_downloads = stats_data.get("downloads", None)
        else:
            num_downloads = None

        resolved_packages.append(
            dict(
                **package,
                weekly_downloads=num_downloads,
            )
        )

    return resolved_packages


def main(output_file: str) -> None:
    """Main function to generate package download information.

    Args:
        output_file: Path to the output YAML file.
    """
    resolved_packages: list[ResolvedPackage] = _get_weekly_downloads(PACKAGES)

    if not output_file.endswith(".yml"):
        raise ValueError("Output file must have a .yml extension")

    with open(output_file, "w") as f:
        f.write("# This file is auto-generated. Do not edit.\n")
        yaml.dump(resolved_packages, f)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Generate package download information."
    )
    parser.add_argument(
        "output_file",
        help=(
            "Path to the output YAML file. Example: python generate_downloads.py "
            "downloads.yml"
        ),
    )
    args = parser.parse_args()

    main(args.output_file)
