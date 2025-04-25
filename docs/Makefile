.PHONY: clean build-docs serve-docs serve-clean-docs llms-text generate-prebuilt-page

build-docs: generate-prebuilt-page
	python _scripts/copy_notebooks.py
	mkdir -p docs/cloud
	if [ -z "$$(ls -A docs/cloud)" ]; then \
		curl -L https://api.github.com/repos/langchain-ai/langgraph/tarball/main | \
		if tar --version 2>&1 | grep -q GNU; then \
			tar -xz --wildcards --strip-components=4 -C docs/cloud "*/docs/docs/cloud/*.md" "*/docs/docs/cloud/*/img/*"; \
			find docs/cloud -type f -name "*.md" -exec sed -i 's/\[[^]]*\]\[[^]]*\]//g' {} +; \
		else \
			tar -xz --strip-components=4 -C docs/cloud "*/docs/docs/cloud/*.md" "*/docs/docs/cloud/*/img/*"; \
			find docs/cloud -type f -name "*.md" -exec sed -i '' 's/\[[^]]*\]\[[^]]*\]//g' {} +; \
		fi \
	fi
	python -m mkdocs build --clean -f mkdocs.yml --strict -d site

generate-prebuilt-page:
	# Use to create an update to date prebuilt page.
	# Looks up download stats for each of the prebuilt packages and
	# generates the final prebuilt page.
	python -m _scripts.third_party.get_download_stats stats.yml
	python -m _scripts.third_party.create_third_party_page stats.yml docs/agents/prebuilt.md --language js


serve-docs:
	python _scripts/copy_notebooks.py
	python -m mkdocs serve -f mkdocs.yml -w ../libs --dirty -o

serve-clean-docs: clean
	python _scripts/copy_notebooks.py
	python -m mkdocs serve -c -f mkdocs.yml --strict -w ../libs

clean:
	find ./docs -path "./docs/troubleshooting/errors" -prune -o -name "*.ipynb" -type f -exec rm {} \;
	rm -rf docs/cloud
	rm -rf site

llms-text:
	python _scripts/generate_llms_text.py docs/llms-full.txt

