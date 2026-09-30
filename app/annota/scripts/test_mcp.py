import base64
import json
import urllib.request

URL = "http://127.0.0.1:8794/mcp"


def post(payload, session=None):
    req = urllib.request.Request(
        URL,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            **({"Mcp-Session-Id": session} if session else {}),
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        body = r.read().decode()
        headers = dict(r.headers)
    return body, headers


def parse_last_data(body: str):
    """SSE 最后一条 data: 行通常是 JSON-RPC 结果"""
    for line in reversed(body.strip().splitlines()):
        line = line.strip()
        if line.startswith("data:"):
            return json.loads(line[5:].strip())
    raise ValueError("no SSE data line")


if __name__ == "__main__":
    body, headers = post(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "annota-test", "version": "0.1.0"},
            },
        }
    )
    session = headers.get("mcp-session-id") or headers.get("Mcp-Session-Id")
    print("session:", session)

    body, _ = post({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, session)
    tools = parse_last_data(body)
    print("tools:", json.dumps(tools, ensure_ascii=False, indent=2))

    body, _ = post(
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "capture_frame", "arguments": {}},
        },
        session,
    )
    result = parse_last_data(body)
    text = result["result"]["content"][0]["text"]
    data = json.loads(text)
    print(
        "capture_frame:",
        data["format"],
        data["width"],
        "x",
        data["height"],
        len(data["base64"]),
        "base64 chars",
    )

    import os
    import tempfile

    out = os.path.join(tempfile.gettempdir(), "annota_capture_test.png")
    with open(out, "wb") as f:
        f.write(base64.b64decode(data["base64"]))
    print("saved:", out)

    # 测试剪贴板 tool
    body, _ = post(
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "copy_to_clipboard",
                "arguments": {
                    "text": "Annota clipboard text from MCP",
                    "html": "<p><b>Annota</b> clipboard from <i>MCP</i></p>",
                },
            },
        },
        session,
    )
    print("copy_to_clipboard:", parse_last_data(body))
    print("pbpaste plain:", end=" ")
    import subprocess
    print(subprocess.run(["pbpaste"], capture_output=True, text=True).stdout[:200])
