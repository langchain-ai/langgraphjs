.PHONY: clean build-docs serve-docs serve-clean-docs
	
build-docs:
	python _scripts/copy_notebooks.py
	mkdir -p docs/cloud
	if [ -z "$$(ls -A docs/cloud)" ]; then \
		curl -L https://api.github.com/repos/langchain-ai/langgraph/tarball/main | \
		if tar --version 2>&1 | grep -q GNU; then \
			tar -xz --wildcards --strip-components=4 -C docs/cloud "*/docs/docs/cloud/*.md" "*/docs/docs/cloud/*/img/*"; \
		else \
			tar -xz --strip-components=4 -C docs/cloud "*/docs/docs/cloud/*.md" "*/docs/docs/cloud/*/img/*"; \
		fi \
	fi
	find docs/cloud -type f -name "*.md" -exec sed -i '' 's/\[[^]]*\]\[[^]]*\]//g' {} +
	python -m mkdocs build --clean -f mkdocs.yml --strict -d site

serve-docs:
	python _scripts/copy_notebooks.py
	python -m mkdocs serve -f mkdocs.yml -w ../libs --dirty -o

serve-clean-docs: clean
	python _scripts/copy_notebooks.py
	python -m mkdocs serve -c -f mkdocs.yml --strict -w ../libs

clean:
	find ./docs -name "*.ipynb" -type f -delete
	rm -rf docs/cloud
	rm -rf site