import os
import shutil
from pathlib import Path

root_dir = Path(__file__).resolve().parents[2]

examples_dir = root_dir / "examples"
docs_dir = root_dir / "docs/docs"
how_tos_dir = docs_dir / "how-tos"
tutorials_dir = docs_dir / "tutorials"

_MANUAL = {
    "how-tos": [
        "examples/how-tos/persistence.ipynb",
        "examples/how-tos/stream-tokens.ipynb",
    ],
    "tutorials": [
        "quickstart/quickstart.ipynb",
        "chatbots/customer_support_mistral.ipynb",
        "rag/langgraph_agentic_rag.ipynb",
        "rag/langgraph_crag.ipynb",
        "rag/langgraph_self_rag.ipynb",
        "rag/langgraph_adaptive_rag_local.ipynb",
        "multi_agent/multi_agent_collaboration.ipynb",
        "multi_agent/agent_supervisor.ipynb",
        "multi_agent/hierarchical_agent_teams.ipynb",
    ],
}
_MANUAL_INVERSE = {v: docs_dir / k for k, vs in _MANUAL.items() for v in vs}
_HOW_TOS = {
    "agent_executor",
    "chat_agent_executor_with_function_calling",
    "docs",
    "how-tos",
}
_MAP = {}
_HIDE = set(
    str(examples_dir / f)
    for f in [
        "agent_executor/base.ipynb",
        "chat_agent_executor_with_function_calling/base.ipynb",
        "rag/langgraph_crag_mistral.ipynb",
    ]
)
_HIDDEN_DIRS = {"advanced_agents"}


def clean_notebooks():
    roots = (how_tos_dir, tutorials_dir)
    for dir_ in roots:
        traversed = []
        for root, dirs, files in os.walk(dir_):
            for file in files:
                if file.endswith(".ipynb") or file.endswith(".png"):
                    os.remove(os.path.join(root, file))
            # Now delete the dir if it is empty now
            if root not in roots:
                traversed.append(root)

        for root in reversed(traversed):
            if not os.listdir(root):
                os.rmdir(root)


def copy_notebooks():
    # Nested ones are mostly tutorials rn
    for root, dirs, files in os.walk(examples_dir):
        if any(
            path.startswith(".") or path.startswith("__") or path in _HIDDEN_DIRS
            for path in root.split(os.sep)
        ):
            continue
        if any(path in _HOW_TOS for path in root.split(os.sep)):
            dst_dir = how_tos_dir
        else:
            dst_dir = tutorials_dir
        for file in files:
            if "Untitled" in file:
                continue
            dst_dir_ = dst_dir
            if file.endswith((".ipynb", ".png", ".jpg", ".jpeg")):
                if file in _MAP:
                    dst_dir = os.path.join(dst_dir, _MAP[file])
                src_path = os.path.join(root, file)
                if src_path in _HIDE:
                    print("Hiding:", src_path)
                    continue
                dst_path = os.path.join(
                    dst_dir, os.path.relpath(src_path, examples_dir)
                ).replace("how-tos/how-tos", "how-tos")
                for k in _MANUAL_INVERSE:
                    if src_path.endswith(k):
                        overridden_dir = _MANUAL_INVERSE[k]
                        dst_path = os.path.join(
                            overridden_dir, os.path.relpath(src_path, examples_dir)
                        )
                        dst_path = dst_path.replace("how-tos/how-tos", "how-tos")
                        print(f"Overriding: {src_path} to {dst_path}")
                        break
                os.makedirs(os.path.dirname(dst_path), exist_ok=True)
                print(f"Copying: {src_path} to {dst_path}")
                shutil.copy(src_path, dst_path)
                # Convert all ./img/* to ../img/*
                if file.endswith(".ipynb"):
                    with open(dst_path, "r") as f:
                        content = f.read()
                    content = content.replace("(./img/", "(../img/")
                    with open(dst_path, "w") as f:
                        f.write(content)
                dst_dir = dst_dir_


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--no-clean", action="store_true")
    parser.add_argument("--no-copy", action="store_true")
    args = parser.parse_args()
    if not args.no_clean:
        clean_notebooks()
    if not args.no_copy:
        copy_notebooks()
