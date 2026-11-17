"""A scripted OpenAI Chat Completions model: first it asks for Kition's note_inspect tool,
then, once a tool result is in the conversation, it answers in text. Logs every request."""
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.jsonl"

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({"data": [{"id": "scripted", "object": "model"}]}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["content-length"])))
        with open(LOG, "a") as log:
            log.write(json.dumps(request) + "\n")
        names = [tool["function"]["name"] for tool in request.get("tools", [])]
        inspect = next((name for name in names if name.endswith("note_inspect")), None)
        tool_results = [m for m in request.get("messages", []) if m.get("role") == "tool"]
        def chunk(delta, finish=None):
            return {"id": "c1", "object": "chat.completion.chunk", "model": "scripted", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        if inspect and not tool_results:
            args = json.dumps({"path": "notes/Plan.md", "preview": False})
            chunks = [chunk({"role": "assistant", "tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": inspect, "arguments": args}}]}), chunk({}, "tool_calls")]
        else:
            text = "No Kition tools were offered." if not inspect else "Kition says: " + (tool_results[-1].get("content") if isinstance(tool_results[-1].get("content"), str) else json.dumps(tool_results[-1].get("content")))[:200]
            chunks = [chunk({"role": "assistant", "content": text}), chunk({}, "stop")]
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        for item in chunks:
            self.wfile.write(f"data: {json.dumps(item)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()

HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
