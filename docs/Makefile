.PHONY: clean

serve-docs:
	python _scripts/copy_notebooks.py
	mkdocs serve -w ../langgraph

clean:
	find ./docs -name "*.ipynb" -type f -delete
	rm -rf site
