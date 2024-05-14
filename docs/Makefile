.PHONY: clean build-docs serve-docs

build-docs:
	python _scripts/copy_notebooks.py
	mkdocs build -d ../langgraph/site

serve-docs: build-docs
	mkdocs serve -w ../langgraph

clean:
	find ./docs -name "*.ipynb" -type f -delete
	rm -rf site