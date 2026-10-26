#!/usr/bin/env python3
"""A bounded, local stand-in for `bub acp`; never talks to a real model.

Speaks the part of ACP Droppen uses: initialize, session/new, session/load,
session/set_config_option, session/close, session/prompt and session/cancel.
Its sessions offer a model and a reasoning effort as configuration options,
as Bub's do. Everything it is asked is appended to `bub-calls.jsonl` in its
working directory — or to `$FAKE_BUB_LOG`, which a probe's scratch directory
needs — so a test can read what it was sent. A prompt containing "wait" holds
its turn open until it is cancelled.
"""
import json
import os
from pathlib import Path
import sys
import threading

if sys.argv[1:] != ["acp"]:
    sys.exit(2)

# A plugin that prints to the wrong stream: not the protocol, and the client
# has to read past it.
print("bub: loading plugins", flush=True)

cwd = Path.cwd()
calls = Path(os.environ["FAKE_BUB_LOG"]) if os.environ.get("FAKE_BUB_LOG") else cwd / "bub-calls.jsonl"
lock = threading.Lock()
waiting = {}

MODELS = [("fake:small", "Small"), ("openrouter:vendor/big", "Big")]
EFFORTS = ["auto", "low", "high"]
# Each session's model and effort, as set_config_option leaves them.
runtime = {}


def config_options(session):
    current = runtime.setdefault(session, {"model": MODELS[0][0], "reasoning_effort": "auto"})
    return [
        {"id": "model", "name": "Model", "category": "model", "type": "select",
         "currentValue": current["model"], "options": [{"value": v, "name": n} for v, n in MODELS]},
        {"id": "reasoning_effort", "name": "Reasoning effort", "category": "thought_level", "type": "select",
         "currentValue": current["reasoning_effort"], "options": [{"value": v, "name": v.title()} for v in EFFORTS]},
        {"id": "fast", "name": "Fast", "type": "boolean", "currentValue": False},
    ]


def log(entry):
    with lock, calls.open("a") as out:
        out.write(json.dumps(entry) + "\n")


def emit(value):
    with lock:
        sys.stdout.write(json.dumps(value) + "\n")
        sys.stdout.flush()


def update(session, body):
    emit({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session, "update": body}})


def chunk(kind, text):
    return {"sessionUpdate": kind, "content": {"type": "text", "text": text}}


def answer(request, result):
    emit({"jsonrpc": "2.0", "id": request["id"], "result": result})


def run_turn(request):
    params = request["params"]
    session = params["sessionId"]
    text = params["prompt"][0]["text"]
    if "wait" in text:
        done = threading.Event()
        waiting[session] = done
        update(session, chunk("agent_message_chunk", "Working on it"))
        done.wait(30)
        answer(request, {"stopReason": "cancelled"})
        return
    update(session, chunk("agent_thought_chunk", "Thinking about "))
    update(session, chunk("agent_thought_chunk", text))
    update(session, {"sessionUpdate": "tool_call", "toolCallId": "call-1", "title": "echo hi",
                     "kind": "execute", "status": "in_progress", "rawInput": {"cmd": "echo hi"}})
    update(session, {"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "completed",
                     "content": [{"type": "content", "content": {"type": "text", "text": "hi"}}]})
    update(session, chunk("agent_message_chunk", "Hello "))
    update(session, chunk("agent_message_chunk", "from Bub"))
    # Bub reports its context usage after the answer streams, as the real one does.
    update(session, {"sessionUpdate": "usage_update", "used": 4020, "size": 128000})
    answer(request, {"stopReason": "end_turn"})


for raw in sys.stdin:
    request = json.loads(raw)
    method = request.get("method")
    params = request.get("params", {})
    log({"method": method, "params": params, "mark": os.environ.get("FAKE_BUB_MARK")})
    if method == "session/cancel":
        done = waiting.pop(params.get("sessionId"), None)
        if done:
            done.set()
    elif method == "initialize":
        answer(request, {"protocolVersion": 1, "agentCapabilities": {
            "loadSession": True, "sessionCapabilities": {"close": {}}}})
    elif method == "session/new":
        session = "f00dfeed0123456789abcdef01234567"
        runtime.pop(session, None)
        answer(request, {"sessionId": session, "configOptions": config_options(session)})
    elif method == "session/set_config_option":
        session, config, value = params["sessionId"], params["configId"], params["value"]
        allowed = {"model": [v for v, _ in MODELS], "reasoning_effort": EFFORTS}.get(config)
        if allowed is None or value not in allowed:
            emit({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32602, "message": f"invalid {config}: {value}"}})
        else:
            config_options(session)
            runtime[session][config] = value
            answer(request, {"configOptions": config_options(session)})
    elif method == "session/close":
        runtime.pop(params["sessionId"], None)
        answer(request, {})
    elif method == "session/load":
        session = params["sessionId"]
        update(session, chunk("user_message_chunk", "an old question"))
        update(session, chunk("agent_message_chunk", "an old answer"))
        answer(request, {"configOptions": config_options(session)})
    elif method == "session/prompt":
        threading.Thread(target=run_turn, args=(request,), daemon=True).start()
    elif "id" in request:
        emit({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "unknown"}})
