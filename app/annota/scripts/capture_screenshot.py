#!/usr/bin/env python3
"""Capture Annota's current window through the local MCP server for UI review."""
import argparse
import base64
import json
import time
import urllib.request


def post(url, payload, session=None):
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if session:
        headers["Mcp-Session-Id"] = session
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers=headers, method="POST"
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode(), dict(response.headers)


def last_data(body):
    for line in reversed(body.splitlines()):
        if line.startswith("data:"):
            return json.loads(line[5:].strip())
    raise RuntimeError("MCP response did not contain an SSE data frame")


def call_tool(url, session, request_id, name, arguments=None):
    body, _ = post(url, {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments or {}},
    }, session)
    result = last_data(body)
    if "error" in result:
        raise RuntimeError(result["error"])
    return result["result"]["content"][0]["text"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8794/mcp")
    parser.add_argument("--output", default="/tmp/annota-ui.png")
    parser.add_argument("--navigate", help="navigate the app browser before capture")
    parser.add_argument("--open-panel", action="store_true")
    parser.add_argument("--propose-word")
    parser.add_argument("--label", default="")
    parser.add_argument("--box", default="0.3,0.3,0.2,0.15", help="normalized x,y,w,h")
    parser.add_argument("--time", type=float, default=3.0)
    parser.add_argument("--duration", type=float, default=1.0)
    parser.add_argument("--wait", type=float, default=0.5)
    args = parser.parse_args()

    body, headers = post(args.url, {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "annota-ui-check", "version": "1"},
        },
    })
    initialized = last_data(body)
    if "error" in initialized:
        raise RuntimeError(initialized["error"])
    session = headers.get("mcp-session-id") or headers.get("Mcp-Session-Id")
    if not session:
        raise RuntimeError("MCP initialize did not return a session id")

    request_id = 2

    def step(name, arguments=None):
        nonlocal request_id
        out = call_tool(args.url, session, request_id, name, arguments)
        request_id += 1
        return out

    if args.navigate:
        print(step("navigate", {"url": args.navigate}))
        time.sleep(args.wait)
    if args.propose_word:
        x, y, w, h = (float(value) for value in args.box.split(","))
        print(step("propose_annotation", {
            "box": {"x": x, "y": y, "w": w, "h": h},
            "word": args.propose_word,
            "label": args.label,
            "t": args.time,
            "dur": args.duration,
        }))
        time.sleep(args.wait)
    if args.open_panel:
        print(step("open_annotations"))
        time.sleep(args.wait)

    capture = json.loads(call_tool(args.url, session, 3, "capture_frame"))
    with open(args.output, "wb") as image:
        image.write(base64.b64decode(capture["base64"]))
    print(f"saved {args.output} ({capture['width']}x{capture['height']}, {capture['bytes']} bytes)")


if __name__ == "__main__":
    main()
