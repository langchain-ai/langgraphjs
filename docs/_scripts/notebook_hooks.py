import logging
import os
import posixpath
import re
from typing import Any, Dict

from bs4 import BeautifulSoup
from mkdocs.config.defaults import MkDocsConfig
from mkdocs.structure.files import Files, File
from mkdocs.structure.pages import Page

from notebook_convert import convert_notebook

logger = logging.getLogger(__name__)
logging.basicConfig()
logger.setLevel(logging.INFO)
DISABLED = os.getenv("DISABLE_NOTEBOOK_CONVERT") in ("1", "true", "True")

REDIRECT_MAP = {
    # cloud redirects
    "cloud/index.md": "index.md",
    "cloud/how-tos/index.md": "concepts/langgraph_platform",
    "cloud/concepts/api.md": "concepts/langgraph_server.md",
    "cloud/concepts/cloud.md": "concepts/langgraph_cloud.md",
    "cloud/faq/studio.md": "concepts/langgraph_studio.md#studio-faqs",
    "cloud/how-tos/human_in_the_loop_edit_state.md": "cloud/how-tos/add-human-in-the-loop.md",
    "cloud/how-tos/human_in_the_loop_user_input.md": "cloud/how-tos/add-human-in-the-loop.md",
    "concepts/platform_architecture.md": "concepts/langgraph_cloud#architecture",
    # cloud streaming redirects
    "cloud/how-tos/stream_values.md": "cloud/how-tos/streaming.md#stream-graph-state",
    "cloud/how-tos/stream_updates.md": "cloud/how-tos/streaming.md#stream-graph-state",
    "cloud/how-tos/stream_messages.md": "cloud/how-tos/streaming.md#messages",
    "cloud/how-tos/stream_events.md": "cloud/how-tos/streaming.md#stream-events",
    "cloud/how-tos/stream_debug.md": "cloud/how-tos/streaming.md#debug",
    "cloud/how-tos/stream_multiple.md": "cloud/how-tos/streaming.md#stream-multiple-modes",
    # assistant redirects
    "cloud/how-tos/assistant_versioning.md": "cloud/how-tos/configuration_cloud.md",

     # LGP mintlify migration redirects
    "tutorials/auth/getting_started.md": "https://docs.langchain.com/langgraph-platform/auth",
    "tutorials/auth/resource_auth.md": "https://docs.langchain.com/langgraph-platform/resource-auth",
    "tutorials/auth/add_auth_server.md": "https://docs.langchain.com/langgraph-platform/add-auth-server",
    "how-tos/use-remote-graph.md": "https://docs.langchain.com/langgraph-platform/use-remote-graph",
    "how-tos/autogen-integration.md": "https://docs.langchain.com/langgraph-platform/autogen-integration",
    "cloud/how-tos/use_stream_react.md": "https://docs.langchain.com/langgraph-platform/use-stream-react",
    "cloud/how-tos/generative_ui_react.md": "https://docs.langchain.com/langgraph-platform/generative-ui-react",
    "concepts/langgraph_platform.md": "https://docs.langchain.com/langgraph-platform/index",
    "concepts/langgraph_components.md": "https://docs.langchain.com/langgraph-platform/components",
    "concepts/langgraph_server.md": "https://docs.langchain.com/langgraph-platform/langgraph-server",
    "concepts/langgraph_data_plane.md": "https://docs.langchain.com/langgraph-platform/data-plane",
    "concepts/langgraph_control_plane.md": "https://docs.langchain.com/langgraph-platform/control-plane",
    "concepts/langgraph_cli.md": "https://docs.langchain.com/langgraph-platform/langgraph-cli",
    "concepts/langgraph_studio.md": "https://docs.langchain.com/langgraph-platform/langgraph-studio",
    "cloud/how-tos/studio/quick_start.md": "https://docs.langchain.com/langgraph-platform/quick-start-studio",
    "cloud/how-tos/invoke_studio.md": "https://docs.langchain.com/langgraph-platform/invoke-studio",
    "cloud/how-tos/studio/manage_assistants.md": "https://docs.langchain.com/langgraph-platform/manage-assistants-studio",
    "cloud/how-tos/threads_studio.md": "https://docs.langchain.com/langgraph-platform/threads-studio",
    "cloud/how-tos/iterate_graph_studio.md": "https://docs.langchain.com/langgraph-platform/iterate-graph-studio",
    "cloud/how-tos/studio/run_evals.md": "https://docs.langchain.com/langgraph-platform/run-evals-studio",
    "cloud/how-tos/clone_traces_studio.md": "https://docs.langchain.com/langgraph-platform/clone-traces-studio",
    "cloud/how-tos/datasets_studio.md": "https://docs.langchain.com/langgraph-platform/datasets-studio",
    "concepts/sdk.md": "https://docs.langchain.com/langgraph-platform/sdk",
    "concepts/plans.md": "https://docs.langchain.com/langgraph-platform/plans",
    "concepts/application_structure.md": "https://docs.langchain.com/langgraph-platform/application-structure",
    "concepts/scalability_and_resilience.md": "https://docs.langchain.com/langgraph-platform/scalability-and-resilience",
    "concepts/auth.md": "https://docs.langchain.com/langgraph-platform/auth",
    "how-tos/auth/custom_auth.md": "https://docs.langchain.com/langgraph-platform/custom-auth",
    "how-tos/auth/openapi_security.md": "https://docs.langchain.com/langgraph-platform/openapi-security",
    "concepts/assistants.md": "https://docs.langchain.com/langgraph-platform/assistants",
    "cloud/how-tos/configuration_cloud.md": "https://docs.langchain.com/langgraph-platform/configuration-cloud",
    "cloud/how-tos/use_threads.md": "https://docs.langchain.com/langgraph-platform/use-threads",
    "cloud/how-tos/background_run.md": "https://docs.langchain.com/langgraph-platform/background-run",
    "cloud/how-tos/same-thread.md": "https://docs.langchain.com/langgraph-platform/same-thread",
    "cloud/how-tos/stateless_runs.md": "https://docs.langchain.com/langgraph-platform/stateless-runs",
    "cloud/how-tos/configurable_headers.md": "https://docs.langchain.com/langgraph-platform/configurable-headers",
    "concepts/double_texting.md": "https://docs.langchain.com/langgraph-platform/double-texting",
    "cloud/how-tos/interrupt_concurrent.md": "https://docs.langchain.com/langgraph-platform/interrupt-concurrent",
    "cloud/how-tos/rollback_concurrent.md": "https://docs.langchain.com/langgraph-platform/rollback-concurrent",
    "cloud/how-tos/reject_concurrent.md": "https://docs.langchain.com/langgraph-platform/reject-concurrent",
    "cloud/how-tos/enqueue_concurrent.md": "https://docs.langchain.com/langgraph-platform/enqueue-concurrent",
    "cloud/concepts/webhooks.md": "https://docs.langchain.com/langgraph-platform/use-webhooks",
    "cloud/how-tos/webhooks.md": "https://docs.langchain.com/langgraph-platform/use-webhooks",
    "cloud/concepts/cron_jobs.md": "https://docs.langchain.com/langgraph-platform/cron-jobs",
    "cloud/how-tos/cron_jobs.md": "https://docs.langchain.com/langgraph-platform/cron-jobs",
    "how-tos/http/custom_lifespan.md": "https://docs.langchain.com/langgraph-platform/custom-lifespan",
    "how-tos/http/custom_middleware.md": "https://docs.langchain.com/langgraph-platform/custom-middleware",
    "how-tos/http/custom_routes.md": "https://docs.langchain.com/langgraph-platform/custom-routes",
    "cloud/concepts/data_storage_and_privacy.md": "https://docs.langchain.com/langgraph-platform/data-storage-and-privacy",
    "cloud/deployment/semantic_search.md": "https://docs.langchain.com/langgraph-platform/semantic-search",
    "how-tos/ttl/configure_ttl.md": "https://docs.langchain.com/langgraph-platform/configure-ttl",
    "concepts/deployment_options.md": "https://docs.langchain.com/langgraph-platform/deployment-options",
    "cloud/quick_start.md": "https://docs.langchain.com/langgraph-platform/deployment-quickstart",
    "cloud/deployment/setup.md": "https://docs.langchain.com/langgraph-platform/setup-app-requirements-txt",
    "cloud/deployment/setup_pyproject.md": "https://docs.langchain.com/langgraph-platform/setup-pyproject",
    "cloud/deployment/setup_javascript.md": "https://docs.langchain.com/langgraph-platform/setup-javascript",
    "cloud/deployment/custom_docker.md": "https://docs.langchain.com/langgraph-platform/custom-docker",
    "cloud/deployment/graph_rebuild.md": "https://docs.langchain.com/langgraph-platform/graph-rebuild",
    "concepts/langgraph_cloud.md": "https://docs.langchain.com/langgraph-platform/cloud",
    "concepts/langgraph_self_hosted_data_plane.md": "https://docs.langchain.com/langgraph-platform/self-hosted-data-plane",
    "concepts/langgraph_self_hosted_control_plane.md": "https://docs.langchain.com/langgraph-platform/self-hosted-control-plane",
    "concepts/langgraph_standalone_container.md": "https://docs.langchain.com/langgraph-platform/standalone-container",
    "cloud/deployment/cloud.md": "https://docs.langchain.com/langgraph-platform/cloud",
    "cloud/deployment/self_hosted_data_plane.md": "https://docs.langchain.com/langgraph-platform/deploy-self-hosted-data-plane",
    "cloud/deployment/self_hosted_control_plane.md": "https://docs.langchain.com/langgraph-platform/deploy-self-hosted-control-plane",
    "cloud/deployment/standalone_container.md": "https://docs.langchain.com/langgraph-platform/deploy-standalone-container",
    "concepts/server-mcp.md": "https://docs.langchain.com/langgraph-platform/server-mcp",
    "cloud/how-tos/human_in_the_loop_time_travel.md": "https://docs.langchain.com/langgraph-platform/human-in-the-loop-time-travel",
    "cloud/how-tos/add-human-in-the-loop.md": "https://docs.langchain.com/langgraph-platform/add-human-in-the-loop",
    "cloud/deployment/egress.md": "https://docs.langchain.com/langgraph-platform/env-var",
    "cloud/how-tos/streaming.md": "https://docs.langchain.com/langgraph-platform/streaming",
    "cloud/reference/api/api_ref.md": "https://docs.langchain.com/langgraph-platform/server-api-ref",
    "cloud/reference/langgraph_server_changelog.md": "https://docs.langchain.com/langgraph-platform/langgraph-server-changelog",
    "cloud/reference/api/api_ref_control_plane.md": "https://docs.langchain.com/langgraph-platform/api-ref-control-plane",
    "cloud/reference/cli.md": "https://docs.langchain.com/langgraph-platform/cli",
    "cloud/reference/env_var.md": "https://docs.langchain.com/langgraph-platform/env-var",
    "troubleshooting/studio.md": "https://docs.langchain.com/langgraph-platform/troubleshooting-studio",

    # LangGraph mintlify migration redirects
    "index.md": "https://docs.langchain.com/oss/overview",
    "troubleshooting/errors/GRAPH_RECURSION_LIMIT.md": "https://docs.langchain.com/oss/GRAPH_RECURSION_LIMIT",
    "troubleshooting/errors/index.md": "https://docs.langchain.com/oss/common-errors",
    "troubleshooting/errors/INVALID_CHAT_HISTORY.md": "https://docs.langchain.com/oss/INVALID_CHAT_HISTORY",
    "troubleshooting/errors/INVALID_CONCURRENT_GRAPH_UPDATE.md": "https://docs.langchain.com/oss/INVALID_CONCURRENT_GRAPH_UPDATE",
    "troubleshooting/errors/INVALID_GRAPH_NODE_RETURN_VALUE.md": "https://docs.langchain.com/oss/INVALID_GRAPH_NODE_RETURN_VALUE",
    "troubleshooting/errors/INVALID_LICENSE.md": "https://docs.langchain.com/oss/common-errors",
    "troubleshooting/errors/MULTIPLE_SUBGRAPHS.md": "https://docs.langchain.com/oss/MULTIPLE_SUBGRAPHS",
    "agents/agents.md": "https://docs.langchain.com/oss/agentic-architectures",
    "concepts/why-langgraph.md": "https://docs.langchain.com/oss/why-langgraph",
    "tutorials/get-started/1-build-basic-chatbot.md": "https://docs.langchain.com/oss/get-started/1-build-basic-chatbot",
    "tutorials/get-started/2-add-tools.md": "https://docs.langchain.com/oss/get-started/2-add-tools",
    "tutorials/get-started/3-add-memory.md": "https://docs.langchain.com/oss/get-started/3-add-memory",
    "tutorials/get-started/4-human-in-the-loop.md": "https://docs.langchain.com/oss/get-started/4-human-in-the-loop",
    "tutorials/get-started/5-customize-state.md": "https://docs.langchain.com/oss/get-started/5-customize-state",
    "tutorials/get-started/6-time-travel.md": "https://docs.langchain.com/oss/get-started/6-time-travel",
    "tutorials/langgraph-platform/local-server.md": "https://docs.langchain.com/oss/local-server",
    "tutorials/workflows.md": "https://docs.langchain.com/oss/agentic-architectures",
    "concepts/agentic_concepts.md": "https://docs.langchain.com/oss/agentic-architectures",
    "guides/index.md": "https://docs.langchain.com/oss/overview",
    "agents/overview.md": "https://docs.langchain.com/oss/prebuilts",
    "concepts/agentic_concepts.md": "https://docs.langchain.com/oss/agentic-architectures",
    "agents/run_agents.md": "https://docs.langchain.com/oss/run-an-agent",
    "concepts/low_level.md": "https://docs.langchain.com/oss/graph-api",
    "how-tos/graph-api.md": "https://docs.langchain.com/oss/use-graph-api",
    "concepts/functional_api.md": "https://docs.langchain.com/oss/functional-api",
    "how-tos/use-functional-api.md": "https://docs.langchain.com/oss/use-functional-api",
    "concepts/pregel.md": "https://docs.langchain.com/oss/pregel",
    "concepts/streaming.md": "https://docs.langchain.com/oss/streaming",
    "how-tos/streaming.md": "https://docs.langchain.com/oss/use-streaming",
    "concepts/persistence.md": "https://docs.langchain.com/oss/persistence",
    "concepts/durable_execution.md": "https://docs.langchain.com/oss/durable-execution",
    "concepts/memory.md": "https://docs.langchain.com/oss/memory",
    "how-tos/memory/add-memory.md": "https://docs.langchain.com/oss/add-memory",
    "agents/context.md": "https://docs.langchain.com/oss/context",
    "agents/models.md": "https://docs.langchain.com/oss/models",
    "concepts/tools.md": "https://docs.langchain.com/oss/tools",
    "how-tos/tool-calling.md": "https://docs.langchain.com/oss/call-tools",
    "concepts/human_in_the_loop.md": "https://docs.langchain.com/oss/human-in-the-loop",
    "how-tos/human_in_the_loop/add-human-in-the-loop.md": "https://docs.langchain.com/oss/add-human-in-the-loop",
    "concepts/time-travel.md": "https://docs.langchain.com/oss/time-travel",
    "how-tos/human_in_the_loop/time-travel.md": "https://docs.langchain.com/oss/use-time-travel",
    "concepts/subgraphs.md": "https://docs.langchain.com/oss/subgraphs",
    "how-tos/subgraph.md": "https://docs.langchain.com/oss/use-subgraphs",
    "concepts/multi_agent.md": "https://docs.langchain.com/oss/multi-agent",
    "agents/multi-agent.md": "https://docs.langchain.com/oss/multi-agent-prebuilts",
    "how-tos/multi_agent.md": "https://docs.langchain.com/oss/multi-agent-custom",
    "concepts/mcp.md": "https://docs.langchain.com/oss/mcp",
    "agents/mcp.md": "https://docs.langchain.com/oss/use-mcp",
    "concepts/tracing.md": "https://docs.langchain.com/oss/trace-agent",
    "how-tos/enable-tracing.md": "https://docs.langchain.com/oss/trace-agent",
    "agents/evals.md": "https://docs.langchain.com/oss/evals",
    "examples/index.md": "https://docs.langchain.com/oss/case-studies",
    "concepts/template_applications.md": "https://docs.langchain.com/oss/template-applications",
    "tutorials/rag/langgraph_agentic_rag.md": "https://docs.langchain.com/oss/agentic-rag",
    "tutorials/multi_agent/agent_supervisor.md": "https://docs.langchain.com/oss/agent-supervisor",
    "tutorials/sql/sql-agent.md": "https://docs.langchain.com/oss/sql-agent",
    "agents/ui.md": "https://docs.langchain.com/oss/ui",
    "how-tos/run-id-langsmith.md": "https://docs.langchain.com/oss/run-id-langsmith",
    "troubleshooting/errors/index.md": "https://docs.langchain.com/oss/common-errors",
    "troubleshooting/errors/GRAPH_RECURSION_LIMIT.md": "https://docs.langchain.com/oss/GRAPH_RECURSION_LIMIT",
    "troubleshooting/errors/INVALID_CONCURRENT_GRAPH_UPDATE.md": "https://docs.langchain.com/oss/INVALID_CONCURRENT_GRAPH_UPDATE",
    "troubleshooting/errors/INVALID_GRAPH_NODE_RETURN_VALUE.md": "https://docs.langchain.com/oss/INVALID_GRAPH_NODE_RETURN_VALUE",
    "troubleshooting/errors/MULTIPLE_SUBGRAPHS.md": "https://docs.langchain.com/oss/MULTIPLE_SUBGRAPHS",
    "troubleshooting/errors/INVALID_CHAT_HISTORY.md": "https://docs.langchain.com/oss/INVALID_CHAT_HISTORY",
    "troubleshooting/errors/INVALID_LICENSE.md": "https://docs.langchain.com/oss/common-errors",
    "adopters.md": "https://docs.langchain.com/oss/case-studies",
    "concepts/faq.md": "https://docs.langchain.com/oss/faq",
    "agents/prebuilt.md": "https://docs.langchain.com/oss/community-agents",
}


class NotebookFile(File):
    def is_documentation_page(self):
        return True


def on_files(files: Files, **kwargs: Dict[str, Any]):
    if DISABLED:
        return files
    new_files = Files([])
    for file in files:
        if file.src_path.endswith(".ipynb"):
            new_file = NotebookFile(
                path=file.src_path,
                src_dir=file.src_dir,
                dest_dir=file.dest_dir,
                use_directory_urls=file.use_directory_urls,
            )
            new_files.append(new_file)
        else:
            new_files.append(file)
    return new_files


def _highlight_code_blocks(markdown: str) -> str:
    """Find code blocks with highlight comments and add hl_lines attribute.

    Args:
        markdown: The markdown content to process.

    Returns:
        updated Markdown code with code blocks containing highlight comments
        updated to use the hl_lines attribute.
    """
    # Pattern to find code blocks with highlight comments and without
    # existing hl_lines for Python and JavaScript
    # Pattern to find code blocks with highlight comments, handling optional indentation
    code_block_pattern = re.compile(
        r"(?P<indent>[ \t]*)```(?P<language>py|python|js|javascript|ts|typescript)(?!\s+hl_lines=)\n"
        r"(?P<code>((?:.*\n)*?))"  # Capture the code inside the block using named group
        r"(?P=indent)```"  # Match closing backticks with the same indentation
    )

    def replace_highlight_comments(match: re.Match) -> str:
        indent = match.group("indent")
        language = match.group("language")
        code_block = match.group("code")
        lines = code_block.split("\n")
        highlighted_lines = []

        # Skip initial empty lines
        while lines and not lines[0].strip():
            lines.pop(0)

        lines_to_keep = []

        comment_syntax = (
            "# highlight-next-line"
            if language in ["py", "python"]
            else "// highlight-next-line"
        )

        for line in lines:
            if comment_syntax in line:
                count = len(lines_to_keep) + 1
                highlighted_lines.append(str(count))
            else:
                lines_to_keep.append(line)

        # Reconstruct the new code block
        new_code_block = "\n".join(lines_to_keep)

        if highlighted_lines:
            return (
                f'{indent}```{language} hl_lines="{" ".join(highlighted_lines)}"\n'
                # The indent and terminating \n is already included in the code block
                f'{new_code_block}'
                f'{indent}```'
            )
        else:
            return (
                f"{indent}```{language}\n"
                # The indent and terminating \n is already included in the code block
                f"{new_code_block}"
                f"{indent}```"
            )

    # Replace all code blocks in the markdown
    markdown = code_block_pattern.sub(replace_highlight_comments, markdown)
    return markdown


def _inject_gtm(html: str) -> str:
    """Inject Google Tag Manager code into the HTML.

    Code to inject Google Tag Manager noscript tag immediately after <body>.

    This is done via hooks rather than via a template because the MkDocs material
    theme does not seem to allow placing the code immediately after the <body> tag
    without modifying the template files directly.

    Args:
        html: The HTML content to modify.

    Returns:
        The modified HTML content with GTM code injected.
    """
    # Code was copied from Google Tag Manager setup instructions.
    gtm_code = """
<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-MVSV6HPQ"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->
"""
    soup = BeautifulSoup(html, "html.parser")
    body = soup.body
    if body:
        # Insert the GTM code as raw HTML at the top of <body>
        body.insert(0, BeautifulSoup(gtm_code, "html.parser"))
        return str(soup)
    else:
        return html  # fallback if no <body> found


def on_post_page(output: str, page: Page, config: MkDocsConfig) -> str:
    """Inject Google Tag Manager noscript tag immediately after <body>.

    Args:
        output: The HTML output of the page.
        page: The page instance.
        config: The MkDocs configuration object.

    Returns:
        modified HTML output with GTM code injected.
    """
    return _inject_gtm(output)



def _on_page_markdown_with_config(
    markdown: str,
    page: Page,
    *,
    remove_base64_images: bool = False,
    **kwargs: Any,
) -> str:
    if DISABLED:
        return markdown
    if page.file.src_path.endswith(".ipynb"):
        logger.info(f"Processing Jupyter notebook: {page.file.src_path}")
        markdown = convert_notebook(page.file.abs_src_path)

    # Apply highlight comments to code blocks
    markdown = _highlight_code_blocks(markdown)

    if remove_base64_images:
        # Remove base64 encoded images from markdown
        markdown = re.sub(r"!\[.*?\]\(data:image/[^;]+;base64,[^\)]+\)", "", markdown)

    return markdown


def on_page_markdown(markdown: str, page: Page, **kwargs: Dict[str, Any]):
    return _on_page_markdown_with_config(
        markdown,
        page,
        **kwargs,
    )


# redirects

HTML_TEMPLATE = """
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Redirecting...</title>
    <link rel="canonical" href="{url}">
    <meta name="robots" content="noindex">
    <script>var anchor=window.location.hash.substr(1);location.href="{url}"+(anchor?"#"+anchor:"")</script>
    <meta http-equiv="refresh" content="0; url={url}">
</head>
<body>
Redirecting...
</body>
</html>
"""


def _write_html(site_dir, old_path, new_path):
    """Write an HTML file in the site_dir with a meta redirect to the new page"""
    # Determine all relevant paths
    old_path_abs = os.path.join(site_dir, old_path)
    old_dir_abs = os.path.dirname(old_path_abs)

    # Create parent directories if they don't exist
    if not os.path.exists(old_dir_abs):
        os.makedirs(old_dir_abs)

    # Write the HTML redirect file in place of the old file
    content = HTML_TEMPLATE.format(url=new_path)
    with open(old_path_abs, "w", encoding="utf-8") as f:
        f.write(content)


# Create HTML files for redirects after site dir has been built
def on_post_build(config):
    use_directory_urls = config.get("use_directory_urls")
    for page_old, page_new in REDIRECT_MAP.items():
        page_old = page_old.replace(".ipynb", ".md")
        page_new = page_new.replace(".ipynb", ".md")
        page_new_before_hash, hash, suffix = page_new.partition("#")
        old_html_path = File(page_old, "", "", use_directory_urls).dest_path.replace(
            os.sep, "/"
        )
        new_html_path = File(page_new_before_hash, "", "", True).url
        new_html_path = (
            posixpath.relpath(new_html_path, start=posixpath.dirname(old_html_path))
            + hash
            + suffix
        )
        _write_html(config["site_dir"], old_html_path, new_html_path)
