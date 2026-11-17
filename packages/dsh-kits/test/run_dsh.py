"""A real DeepSeek Harness runtime, driven by its own Python SDK, inspects a Kition note
through @kition/dsh-kits (`KitAgent 1.4` D1). Paths come from the environment;
see e2e.sh."""
import os, sys

sys.path.insert(0, os.environ["DSH_PYTHON_SDK"])
from deepseek_harness.api import DeepSeekHarness, DeepSeekHarnessConfig  # noqa: E402

here = os.path.dirname(os.path.abspath(__file__))
workspace = os.environ["KITION_WORKSPACE"]
config = DeepSeekHarnessConfig(
    provider="scripted",
    model="scripted",
    dsh_bin=os.environ["DSH_BIN"],
    profile="sdk",
    patches=(os.path.join(here, "scripted-route.cordis.patch.yml"), os.path.join(here, "..", "kition-kits.stdio.cordis.patch.yml")),
    dsh_home=os.environ["DSH_HOME"],
    cwd=workspace,
    env={**os.environ, "SCRIPTED_API_KEY": "scripted"},
    initialize_timeout_seconds=60,
)
with DeepSeekHarness(config) as harness:
    result = harness.run("Inspect notes/Plan.md with the Kition tools.")
calls = [event["data"]["name"] for event in result.events if event.get("type") == "tool/call"]
results = [event for event in result.events if event.get("type") == "tool/result"]
print("tool calls:", calls)
print("final response:", result.final_response[:120])
assert calls == ["mcp__kition__note_inspect"], calls
assert results and not results[0]["data"].get("error"), results
assert result.final_response.startswith("Kition says: Opened `notes/Plan.md`"), result.final_response
print("PASS: DeepSeek Harness used Kition's kit tools")
