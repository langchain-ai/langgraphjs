.PHONY: clean build-docs serve-docs serve-clean-docs

build-docs:
	python _scripts/copy_notebooks.py
	python -m mkdocs build --clean -f mkdocs.yml --strict -d site

serve-docs:
	python _scripts/copy_notebooks.py
	python -m mkdocs serve -f mkdocs.yml -w ../langgraph --dirty -o

serve-clean-docs: clean
	python _scripts/copy_notebooks.py
	python -m mkdocs serve -c -f mkdocs.yml --strict -w ../langgraph -o

clean:
	find ./docs -name "*.ipynb" -type f -delete
	rm -rf site