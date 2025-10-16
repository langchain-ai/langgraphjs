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
    "cloud/how-tos/index.md": "https://docs.langchain.com/langsmith/home",
    "cloud/concepts/api.md": "https://docs.langchain.com/langsmith/langgraph-server",
    "cloud/concepts/cloud.md": "https://docs.langchain.com/langsmith/cloud",
    "cloud/faq/studio.md": "https://docs.langchain.com/langsmith/studio",
    "concepts/platform_architecture.md": "https://docs.langchain.com/langsmith/cloud#architecture",

    # migration to docs.langchain.com/oss or docs.langchain.com/langsmith
    "tutorials/quickstart.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/quickstart",
    "tutorials/deployment.md": "https://docs.langchain.com/langsmith/deployments",
    "tutorials/langsmith/local-server.md": "https://docs.langchain.com/langsmith/local-server",
    "concepts/template_applications.md": "https://docs.langchain.com/oss/javascript/langgraph/overview",
    "cloud/quick_start.md": "https://docs.langchain.com/langsmith/deployment-quickstart",
    "how-tos/index.md": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "how-tos/manage-ecosystem-dependencies.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "how-tos/use-in-web-environments.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "how-tos/map-reduce.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "how-tos/branching.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "how-tos/command.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "how-tos/recursion-limit.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "how-tos/defer-node-execution.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "how-tos/persistence.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/persistence",
    "how-tos/persistence-functional.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/persistence",
    "how-tos/subgraph-persistence.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/persistence",
    "how-tos/cross-thread-persistence.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/persistence",
    "how-tos/cross-thread-persistence-functional.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/persistence",
    "how-tos/persistence-postgres.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/persistence",
    "how-tos/manage-conversation-history.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/memory",
    "how-tos/delete-messages.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/memory",
    "how-tos/add-summary-conversation-history.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/memory",
    "how-tos/semantic-search.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/memory",
    "how-tos/breakpoints.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/interrupts",
    "how-tos/dynamic_breakpoints.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/interrupts",
    "how-tos/edit-graph-state.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/interrupts",
    "how-tos/wait-user-input.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/interrupts",
    "how-tos/wait-user-input-functional.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/interrupts",
    "how-tos/time-travel.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/persistence",
    "how-tos/review-tool-calls.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/interrupts",
    "how-tos/review-tool-calls-functional.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/interrupts",
    "how-tos/stream-values.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/streaming",
    "how-tos/stream-updates.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/streaming",
    "how-tos/stream-tokens.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/streaming",
    "how-tos/streaming-tokens-without-langchain.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/streaming",
    "how-tos/streaming-content.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/streaming",
    "how-tos/stream-multiple.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/streaming",
    "how-tos/streaming-events-from-within-tools.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/streaming",
    "how-tos/streaming-from-final-node.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/streaming",
    "how-tos/tool-calling.ipynb": "https://docs.langchain.com/oss/javascript/langchain/tools",
    "how-tos/force-calling-a-tool-first.ipynb": "https://docs.langchain.com/oss/javascript/langchain/tools",
    "how-tos/tool-calling-errors.ipynb": "https://docs.langchain.com/oss/javascript/langchain/tools",
    "how-tos/pass-run-time-values-to-tools.ipynb": "https://docs.langchain.com/oss/javascript/langchain/tools",
    "how-tos/update-state-from-tools.ipynb": "https://docs.langchain.com/oss/javascript/langchain/tools",
    "how-tos/subgraph.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/graph-api",
    "how-tos/subgraphs-manage-state.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/graph-api",
    "how-tos/subgraph-transform-state.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/graph-api",
    "how-tos/multi-agent-network.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/graph-api",
    "how-tos/multi-agent-network-functional.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/graph-api",
    "how-tos/multi-agent-multi-turn-convo.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/graph-api",
    "how-tos/multi-agent-multi-turn-convo-functional.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/graph-api",
    "how-tos/define-state.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "how-tos/input_output_schema.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "how-tos/pass_private_state.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "how-tos/configuration.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "how-tos/node-retry-policies.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "how-tos/node-caching.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "how-tos/dynamically-returning-directly.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "how-tos/respond-in-format.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "how-tos/managing-agent-steps.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "how-tos/create-react-agent.ipynb": "https://docs.langchain.com/oss/javascript/langchain/agents",
    "how-tos/react-memory.ipynb": "https://docs.langchain.com/oss/javascript/langchain/agents",
    "how-tos/react-system-prompt.ipynb": "https://docs.langchain.com/oss/javascript/langchain/agents",
    "how-tos/react-human-in-the-loop.ipynb": "https://docs.langchain.com/oss/javascript/langchain/agents",
    "how-tos/react-return-structured-output.ipynb": "https://docs.langchain.com/oss/javascript/langchain/agents",
    "how-tos/react-agent-from-scratch-functional.ipynb": "https://docs.langchain.com/oss/javascript/langchain/agents",
    "cloud/deployment/setup.md": "https://docs.langchain.com/langsmith/application-structure",
    "cloud/deployment/setup_pyproject.md": "https://docs.langchain.com/langsmith/setup-pyproject",
    "cloud/deployment/setup_javascript.md": "https://docs.langchain.com/langsmith/setup-javascript",
    "cloud/deployment/semantic_search.md": "https://docs.langchain.com/langsmith/semantic-search",
    "cloud/deployment/custom_docker.md": "https://docs.langchain.com/langsmith/custom-docker",
    "cloud/deployment/test_locally.md": "https://docs.langchain.com/langsmith/local-server",
    "cloud/deployment/graph_rebuild.md": "https://docs.langchain.com/langsmith/graph-rebuild",
    "cloud/deployment/cloud.md": "https://docs.langchain.com/langsmith/deploy-to-cloud",
    "how-tos/deploy-self-hosted.md": "https://docs.langchain.com/langsmith/deploy-self-hosted-full-platform",
    "how-tos/use-remote-graph.md": "https://docs.langchain.com/langsmith/use-remote-graph",
    "how-tos/auth/custom_auth.md": "https://docs.langchain.com/langsmith/custom-auth",
    "cloud/how-tos/auth/openapi_security_new.md": "https://docs.langchain.com/langsmith/openapi-security",
    "cloud/how-tos/configuration_cloud.md": "https://docs.langchain.com/langsmith/configuration-cloud",
    "cloud/how-tos/assistant_versioning.md": "https://docs.langchain.com/langsmith/assistants",
    "cloud/how-tos/use_threads.md": "https://docs.langchain.com/langsmith/use-threads",
    "cloud/how-tos/copy_threads.md": "https://docs.langchain.com/langsmith/use-threads",
    "cloud/how-tos/check_thread_status.md": "https://docs.langchain.com/langsmith/use-threads",
    "cloud/how-tos/background_run.md": "https://docs.langchain.com/langsmith/background-run",
    "cloud/how-tos/same-thread.md": "https://docs.langchain.com/langsmith/same-thread",
    "cloud/how-tos/cron_jobs.md": "https://docs.langchain.com/langsmith/cron-jobs",
    "cloud/how-tos/stateless_runs.md": "https://docs.langchain.com/langsmith/stateless-runs",
    "cloud/how-tos/stream_values.md": "https://docs.langchain.com/langsmith/streaming",
    "cloud/how-tos/stream_updates.md": "https://docs.langchain.com/langsmith/streaming",
    "cloud/how-tos/stream_messages.md": "https://docs.langchain.com/langsmith/streaming",
    "cloud/how-tos/stream_events.md": "https://docs.langchain.com/langsmith/streaming",
    "cloud/how-tos/stream_debug.md": "https://docs.langchain.com/langsmith/streaming",
    "cloud/how-tos/stream_multiple.md": "https://docs.langchain.com/langsmith/streaming",
    "cloud/how-tos/use_stream_react.md": "https://docs.langchain.com/langsmith/use-stream-react",
    "cloud/how-tos/generative_ui_react.md": "https://docs.langchain.com/langsmith/generative-ui-react",
    "cloud/how-tos/human_in_the_loop_breakpoint.md": "https://docs.langchain.com/langsmith/add-human-in-the-loop",
    "cloud/how-tos/human_in_the_loop_user_input.md": "https://docs.langchain.com/langsmith/add-human-in-the-loop",
    "cloud/how-tos/human_in_the_loop_edit_state.md": "https://docs.langchain.com/langsmith/add-human-in-the-loop",
    "cloud/how-tos/human_in_the_loop_time_travel.md": "https://docs.langchain.com/langsmith/human-in-the-loop-time-travel",
    "cloud/how-tos/human_in_the_loop_review_tool_calls.md": "https://docs.langchain.com/langsmith/add-human-in-the-loop",
    "cloud/how-tos/interrupt_concurrent.md": "https://docs.langchain.com/langsmith/interrupt-concurrent",
    "cloud/how-tos/rollback_concurrent.md": "https://docs.langchain.com/langsmith/rollback-concurrent",
    "cloud/how-tos/reject_concurrent.md": "https://docs.langchain.com/langsmith/reject-concurrent",
    "cloud/how-tos/enqueue_concurrent.md": "https://docs.langchain.com/langsmith/enqueue-concurrent",
    "cloud/how-tos/webhooks.md": "https://docs.langchain.com/langsmith/use-webhooks",
    "cloud/how-tos/http/custom_middleware.md": "https://docs.langchain.com/langsmith/custom-middleware",
    "cloud/how-tos/http/custom_routes.md": "https://docs.langchain.com/langsmith/custom-routes",
    "cloud/how-tos/test_deployment.md": "https://docs.langchain.com/langsmith/local-server",
    "cloud/how-tos/test_local_deployment.md": "https://docs.langchain.com/langsmith/local-server",
    "cloud/how-tos/invoke_studio.md": "https://docs.langchain.com/langsmith/use-studio",
    "cloud/how-tos/threads_studio.md": "https://docs.langchain.com/langsmith/use-studio",
    "cloud/how-tos/datasets_studio.md": "https://docs.langchain.com/langsmith/use-studio",
    "concepts/index.md": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "concepts/high_level.md": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "concepts/low_level.md": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "concepts/agentic_concepts.md": "https://docs.langchain.com/oss/javascript/langgraph/overview",
    "concepts/multi_agent.md": "https://docs.langchain.com/oss/javascript/langgraph/graph-api",
    "concepts/human_in_the_loop.md": "https://docs.langchain.com/oss/javascript/langgraph/interrupts",
    "concepts/persistence.md": "https://docs.langchain.com/oss/javascript/langgraph/persistence",
    "concepts/memory.md": "https://docs.langchain.com/oss/javascript/langgraph/memory",
    "concepts/streaming.md": "https://docs.langchain.com/oss/javascript/langgraph/streaming",
    "concepts/functional_api.md": "https://docs.langchain.com/oss/javascript/langgraph/functional-api",
    "concepts/langgraph_platform.md": "https://docs.langchain.com/langsmith/home",
    "concepts/deployment_options.md": "https://docs.langchain.com/langsmith/deployments",
    "concepts/plans.md": "https://docs.langchain.com/langsmith/home",
    "concepts/langgraph_server.md": "https://docs.langchain.com/langsmith/langgraph-server",
    "concepts/langgraph_studio.md": "https://docs.langchain.com/langsmith/studio",
    "concepts/langgraph_cli.md": "https://docs.langchain.com/langsmith/cli",
    "concepts/sdk.md": "https://docs.langchain.com/langsmith/sdk",
    "concepts/application_structure.md": "https://docs.langchain.com/langsmith/application-structure",
    "concepts/assistants.md": "https://docs.langchain.com/langsmith/assistants",
    "concepts/double_texting.md": "https://docs.langchain.com/langsmith/double-texting",
    "concepts/auth.md": "https://docs.langchain.com/langsmith/auth",
    "concepts/self_hosted.md": "https://docs.langchain.com/langsmith/self-hosted",
    "concepts/langgraph_cloud.md": "https://docs.langchain.com/langsmith/cloud",
    "concepts/bring_your_own_cloud.md": "https://docs.langchain.com/langsmith/hybrid",
    "tutorials/index.md": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "tutorials/workflows/index.md": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "tutorials/chatbots/customer_support_small_model.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "tutorials/rag/langgraph_agentic_rag.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/agentic-rag",
    "tutorials/rag/langgraph_crag.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "tutorials/rag/langgraph_self_rag.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "tutorials/multi_agent/multi_agent_collaboration.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/graph-api",
    "tutorials/multi_agent/agent_supervisor.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/graph-api",
    "tutorials/multi_agent/hierarchical_agent_teams.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/graph-api",
    "tutorials/plan-and-execute/plan-and-execute.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "tutorials/reflection/reflection.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "tutorials/rewoo/rewoo.ipynb": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "tutorials/chatbot-simulation-evaluation/agent-simulation-evaluation.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/overview",
    "adopters.md": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "llms-txt-overview.md": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "concepts/faq.md": "https://docs.langchain.com/langsmith/faq",
    "troubleshooting/errors/": "https://docs.langchain.com/oss/javascript/langgraph/common-errors",
    "troubleshooting/errors/index.md": "https://docs.langchain.com/oss/javascript/langgraph/common-errors",
    "troubleshooting/errors/GRAPH_RECURSION_LIMIT.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/GRAPH_RECURSION_LIMIT",
    "troubleshooting/errors/INVALID_CONCURRENT_GRAPH_UPDATE.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/INVALID_CONCURRENT_GRAPH_UPDATE",
    "troubleshooting/errors/INVALID_GRAPH_NODE_RETURN_VALUE.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/INVALID_GRAPH_NODE_RETURN_VALUE",
    "troubleshooting/errors/MULTIPLE_SUBGRAPHS.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/MULTIPLE_SUBGRAPHS",
    "troubleshooting/errors/UNREACHABLE_NODE.ipynb": "https://docs.langchain.com/oss/javascript/langgraph/common-errors",
    "agents/overview.md": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "agents/agents.md": "https://docs.langchain.com/oss/javascript/langchain/overview",
    "agents/run_agents.md": "https://docs.langchain.com/oss/javascript/langgraph/quickstart",
    "agents/streaming.md": "https://docs.langchain.com/oss/javascript/langgraph/streaming",
    "agents/models.md": "https://docs.langchain.com/oss/javascript/langgraph/overview",
    "agents/tools.md": "https://docs.langchain.com/oss/javascript/langchain/tools",
    "agents/mcp.md": "https://docs.langchain.com/oss/javascript/langgraph/overview",
    "agents/context.md": "https://docs.langchain.com/oss/javascript/langgraph/memory",
    "agents/memory.md": "https://docs.langchain.com/oss/javascript/langgraph/memory",
    "agents/human-in-the-loop.md": "https://docs.langchain.com/oss/javascript/langgraph/interrupts",
    "agents/multi-agent.md": "https://docs.langchain.com/oss/javascript/langgraph/graph-api",
    "agents/evals.md": "https://docs.langchain.com/oss/javascript/langgraph/overview",
    "agents/deployment.md": "https://docs.langchain.com/langsmith/deployments",
    "agents/ui.md": "https://docs.langchain.com/oss/javascript/langgraph/ui",
    "agents/prebuilt.md": "https://docs.langchain.com/oss/javascript/langchain/agents",
    "reference/index.html": "https://reference.langchain.com/javascript/modules/_langchain_langgraph.html",
    "reference/modules/checkpoint.html": "https://reference.langchain.com/javascript/modules/_langchain_langgraph-checkpoint.html",
    "reference/modules/checkpoint_mongodb.html": "https://reference.langchain.com/javascript/modules/_langchain_langgraph-checkpoint-mongodb.html",
    "reference/modules/checkpoint_postgres.html": "https://reference.langchain.com/javascript/modules/_langchain_langgraph-checkpoint-postgres.html",
    "reference/modules/checkpoint_redis.html": "https://reference.langchain.com/javascript/modules/_langchain_langgraph-checkpoint-redis.html",
    "reference/modules/checkpoint_sqlite.html": "https://reference.langchain.com/javascript/modules/_langchain_langgraph-checkpoint-sqlite.html",
    "reference/modules/checkpoint_validation.html": "https://reference.langchain.com/javascript/modules/_langchain_langgraph-checkpoint.html",
    "reference/modules/langgraph.html": "https://reference.langchain.com/javascript/modules/_langchain_langgraph.html",
    "reference/modules/langgraph_cua.html": "https://reference.langchain.com/javascript/modules/_langchain_langgraph-cua.html",
    "reference/modules/langgraph_supervisor.html": "https://reference.langchain.com/javascript/modules/_langchain_langgraph-supervisor.html",
    "reference/modules/langgraph_swarm.html": "https://reference.langchain.com/javascript/modules/_langchain_langgraph-swarm.html",
    "reference/modules/sdk.html": "https://reference.langchain.com/javascript/modules/_langchain_langgraph-sdk.html"
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
    site_dir = config["site_dir"]

    for page_old, page_new in REDIRECT_MAP.items():
        # Skip directory paths (ending with /)
        if page_old.endswith("/"):
            continue
            
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
        _write_html(site_dir, old_html_path, new_html_path)

    # Create root index.html redirect
    root_redirect_html = """<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Redirecting to LangGraph.js Documentation</title>
    <link rel="canonical" href="https://docs.langchain.com/oss/javascript/langgraph/overview">
    <meta name="robots" content="noindex">
    <script>var anchor=window.location.hash.substr(1);location.href="https://docs.langchain.com/oss/javascript/langgraph/overview"+(anchor?"#"+anchor:"")</script>
    <meta http-equiv="refresh" content="0; url=https://docs.langchain.com/oss/javascript/langgraph/overview">
</head>
<body>
<h1>Documentation has moved</h1>
<p>The LangGraph.js documentation has moved to <a href="https://docs.langchain.com/oss/javascript/langgraph/overview">docs.langchain.com</a>.</p>
<p>Redirecting you now...</p>
</body>
</html>
"""

    root_index_path = os.path.join(site_dir, "index.html")
    with open(root_index_path, "w", encoding="utf-8") as f:
        f.write(root_redirect_html)

    # Create server-side catch-all redirect file for Netlify/Cloudflare Pages
    # This handles any pages not explicitly mapped in REDIRECT_MAP
    redirects_content = """# Netlify/Cloudflare Pages redirect rules
# Specific redirects are handled by individual HTML redirect pages
# This is the catch-all for any unmapped pages

# Catch-all: redirect any page not explicitly mapped
/*  https://docs.langchain.com/oss/javascript/langchain/overview  301
"""

    redirects_path = os.path.join(site_dir, "_redirects")
    with open(redirects_path, "w", encoding="utf-8") as f:
        f.write(redirects_content)
