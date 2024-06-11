import json
import subprocess
from typing import Optional
import re
import jupytext
import logging

tsconfig_path = "tsconfig.json"
logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


def extract_code_blocks(content: str, id_: Optional[int] = None):
    # code_block_regex = re.compile(r"```typescript(?:\s+\{.*?\})?\n([\s\S]*?)```")
    code_block_regex = re.compile(r"```typescript(?:\s+\{(.*?)\})?\n([\s\S]*?)```")

    matches = code_block_regex.findall(content)

    if not matches:
        print("No TypeScript code blocks found.")
        return

    imports = set()
    combined_code = []

    for metadata, code in matches:
        if metadata:
            m = {}
            metadata_parts = metadata.split(",")
            for part in metadata_parts:
                key, value = part.split("=", 1)
                m[key] = value
            metadata = m
            if "id" in metadata and id_ and int(metadata["id"]) != id_:
                logger.info(f'Skipping code block with id: {metadata["id"]}')
                continue
        lines = re.split(r";(?=\n|$)", code)
        for line in lines:
            if line.strip().startswith("import "):
                imports.add(line.rstrip(";"))
            else:
                if "import" in line:
                    breakpoint()
                combined_code.append(line.rstrip(";") + ";")

    res = "\n".join(imports) + "\n\n" + "\n".join(combined_code)
    # Remove any instances of ^;$ from the code
    res = re.sub(r"^;$", "", res, flags=re.MULTILINE)
    return res


def extract_ts_code(file_path: str) -> str:
    with open(file_path, "r", encoding="utf-8") as notebook_file:
        notebook_content = notebook_file.read()
        if file_path.endswith(".ipynb"):
            notebook = jupytext.reads(notebook_content, fmt="ipynb")
            ts_content = jupytext.writes(notebook, fmt="py:percent")
        else:
            ts_content = extract_code_blocks(notebook_content)

    # Strip all lines starting with "#"
    ts_content = "\n".join(
        [line for line in ts_content.split("\n") if not line.startswith("#")]
    )
    return ts_content


def get_tsconfig_options(tsconfig_path: str) -> list:
    with open(tsconfig_path, "r", encoding="utf-8") as tsconfig_file:
        tsconfig = json.load(tsconfig_file)
        compiler_options = tsconfig.get("compilerOptions", {})
        options = []
        for key, value in compiler_options.items():
            options.append(f"--{key}")
            if isinstance(value, bool):
                continue
            elif isinstance(value, list):
                options.append(",".join([str(item) for item in value]))
            else:
                options.append(str(value))
    return options


def compile_ts_code(ts_code: str, tsconfig_options: list) -> str:
    print("Compiling TypeScript code...")
    temp_file_path = "temp.ts"
    with open(temp_file_path, "w") as f:
        f.write(ts_code)
    cmd = ["npx", "tsc", temp_file_path] + tsconfig_options + ["--skipLibCheck"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        stdout = result.stdout
        print("TypeScript compilation successful.")
        print(stdout)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"TypeScript compilation failed:\n{e.stderr}\n\n{e.stdout}")

    compiled_js_path = "dist/" + temp_file_path.replace(".ts", ".js")
    with open(compiled_js_path, "r", encoding="utf-8") as js_file:
        compiled_js_code = js_file.read()

    return compiled_js_code, compiled_js_path


def run_js_code(js_code_path: str) -> str:
    print("Running JavaScript code...")
    process = subprocess.Popen(
        ["npx", "node", js_code_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stdout, stderr = process.communicate()
    if process.returncode != 0:
        raise RuntimeError(f"JavaScript execution failed:\n{stderr}")
    return stdout


import argparse

parser = argparse.ArgumentParser(
    description="Run TypeScript code in a Jupyter notebook."
)
parser.add_argument("filename", type=str, help="Path to the Jupyter notebook file.")
args = parser.parse_args()

ts_code = extract_ts_code(args.filename)
tsconfig_options = get_tsconfig_options(tsconfig_path)
compiled_js_code, compiled_js_path = compile_ts_code(ts_code, tsconfig_options)
output = run_js_code(compiled_js_path)
print(output)
