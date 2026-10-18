#!/usr/bin/env python3
"""Bounded Python AST evidence for Coding Engine. No eval, exec or file I/O.

Input on stdin: {"files":[{"path":"src/a.py","text":"..."}],
                 "symbol":"foo","limit":100}.
Results are syntax-level evidence; an AST does not resolve imports/overloads.
"""
import ast
import json
import sys

MAX_INPUT = 1024 * 1024
MAX_FILES = 16
MAX_MATCHES = 200

def analyze(payload):
    symbol = payload.get("symbol")
    if not isinstance(symbol, str) or not symbol.isidentifier() or len(symbol) > 120:
        raise ValueError("symbol must be a Python identifier")
    files = payload.get("files")
    if not isinstance(files, list) or not 0 < len(files) <= MAX_FILES:
        raise ValueError("files must contain 1..16 items")
    limit = payload.get("limit", 100)
    if type(limit) is not int or not 1 <= limit <= MAX_MATCHES:
        raise ValueError("limit must be 1..200")
    matches, parse_errors = [], []
    exceeded = False
    for file in files:
        if not isinstance(file, dict) or not isinstance(file.get("path"), str) or not isinstance(file.get("text"), str):
            raise ValueError("invalid file entry")
        path, text = file["path"], file["text"]
        try:
            tree = ast.parse(text, filename=path)
        except (SyntaxError, ValueError) as error:
            parse_errors.append({"path": path, "line": getattr(error, "lineno", None),
                                 "message": str(error)[:160]})
            continue
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == symbol:
                kind = "definition"
            elif isinstance(node, ast.Name) and node.id == symbol:
                kind = "reference" if isinstance(node.ctx, ast.Load) else "assignment"
            elif isinstance(node, ast.Attribute) and node.attr == symbol:
                kind = "attribute_candidate"
            elif isinstance(node, ast.Call) and (
                (isinstance(node.func, ast.Name) and node.func.id == symbol) or
                (isinstance(node.func, ast.Attribute) and node.func.attr == symbol)
            ):
                kind = "call_candidate"
            else:
                continue
            if len(matches) >= limit:
                exceeded = True
                break
            matches.append({"path": path, "line": node.lineno,
                            "column": node.col_offset + 1, "kind": kind})
        if exceeded:
            break
    matches.sort(key=lambda x: (x["path"], x["line"], x["column"], x["kind"]))
    return {"backend": "python-ast", "syntaxVerified": True,
            "bindingResolved": False, "matches": matches, "parseErrors": parse_errors,
            "truncated": exceeded}

def main():
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ValueError("AST input exceeds 1 MiB")
    payload = json.loads(raw)
    if payload.get("mode") != "analyze":
        raise ValueError("unsupported AST operation")
    print(json.dumps(analyze(payload), ensure_ascii=False))

if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        print(str(exc)[:240], file=sys.stderr)
        sys.exit(1)
