#!/usr/bin/env python3
"""Fail-closed AST transformations. Never executes a user's source code."""
import ast
import io
import json
import posixpath
import sys
import tokenize

MAX_TOTAL = 1024 * 1024

def replace_symbol(args):
    text = args["text"]
    symbol = args["symbol"]
    new_text = args["newText"]
    tree = ast.parse(text)
    replacement = ast.parse(new_text)
    if len(replacement.body) != 1 or not isinstance(replacement.body[0], (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        raise ValueError("replacement must be exactly one function or class definition")
    if replacement.body[0].name != symbol:
        raise ValueError("replacement symbol must retain its declared name")
    matches = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == symbol]
    if len(matches) != 1:
        raise ValueError("expected exactly one top-level symbol")
    node = matches[0]
    original = text.splitlines(keepends=True)
    begin, end = node.lineno - 1, node.end_lineno
    if node.decorator_list:
        begin = min(d.lineno for d in node.decorator_list) - 1
    old = "".join(original[begin:end])
    if not old:
        raise ValueError("empty source")
    adjusted = new_text.rstrip("\n") + "\n"
    candidate = "".join(original[:begin]) + adjusted + "".join(original[end:])
    ast.parse(candidate)
    if candidate.count(adjusted) != 1 or text.count(old) != 1:
        raise ValueError("ambiguous replacement")
    return {"oldText": old, "newText": adjusted}

def module_of(path):
    if not path.endswith(".py") or path.startswith("/") or ".." in path.split("/"):
        raise ValueError("invalid Python path")
    stem = path[:-3]
    if stem.endswith("/__init__"):
        return stem[:-9].replace("/", ".")
    return stem.replace("/", ".")

def import_origin(path, node):
    if not isinstance(node, ast.ImportFrom) or node.module is None:
        return None
    if node.level:
        pieces = path.split("/")[:-1]
        up = node.level - 1
        if up > len(pieces):
            return None
        pieces = pieces[:len(pieces)-up]
        return ".".join(pieces + node.module.split("."))
    return node.module

def rename(args):
    origin = args["originPath"]
    old, new = args["oldName"], args["newName"]
    if not old.isidentifier() or not new.isidentifier() or old == new:
        raise ValueError("invalid identifiers")
    if old in {"self", "cls"} or new.startswith("__") or new in {"self", "cls"}:
        raise ValueError("unsupported reserved identifier")
    files = args["files"]
    if not isinstance(files, list) or not 1 <= len(files) <= 16:
        raise ValueError("1..16 Python files required")
    if len({f["path"] for f in files}) != len(files):
        raise ValueError("duplicate source paths")
    if origin not in {f["path"] for f in files}:
        raise ValueError("origin must be included")
    target_module = module_of(origin)
    changes = []
    origin_found = False
    for file in files:
        path, text = file["path"], file["text"]
        module_of(path)
        tree = ast.parse(text, filename=path)
        defs = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == old]
        if path == origin:
            if len(defs) != 1:
                raise ValueError("exactly one top-level origin definition required")
            origin_found = True
        elif defs:
            raise ValueError("ambiguous symbol also defined in " + path)
        if any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == new for n in ast.walk(tree)):
            raise ValueError("target name collides with a definition in " + path)
        imports = []
        for n in ast.walk(tree):
            if isinstance(n, (ast.ImportFrom, ast.Import)):
                aliases = n.names
                for alias in aliases:
                    if alias.asname in (old, new):
                        raise ValueError("aliased import may shadow renamed binding: " + path)
                    if isinstance(n, ast.ImportFrom) and alias.name == old:
                        if import_origin(path, n) != target_module:
                            raise ValueError("ambiguous import of same name in " + path)
                        imports.append((n, alias))
                if isinstance(n, ast.Import):
                    if any(x.name == target_module for x in aliases):
                        raise ValueError("module-qualified access needs LSP: " + path)
            if isinstance(n, ast.Attribute) and n.attr == old:
                raise ValueError("attribute access needs binding resolution: " + path)
            if isinstance(n, ast.arg) and n.arg in (old, new):
                raise ValueError("local parameter may shadow renamed binding: " + path)
            if isinstance(n, ast.Name) and n.id in (old, new) and isinstance(n.ctx, (ast.Store, ast.Del)):
                raise ValueError("local assignment may shadow renamed binding: " + path)
            if isinstance(n, (ast.Global, ast.Nonlocal)) and (old in n.names or new in n.names):
                raise ValueError("global/nonlocal binding requires LSP: " + path)
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n is not (defs[0] if defs else None) and n.name == old:
                raise ValueError("nested symbol collision in " + path)
        if path != origin and not imports:
            if any(isinstance(n, ast.Name) and n.id == old for n in ast.walk(tree)):
                raise ValueError("unresolved name in file lacking explicit import: " + path)
            continue
        if len(imports) > 1:
            raise ValueError("duplicate imports are ambiguous")
        # Restrict transformation to a single module-level source binding and
        # clients explicitly importing from that module without aliases.
        eligible = path == origin or bool(imports)
        if not eligible:
            continue
        original = text.splitlines(keepends=True)
        positions = set()
        for n in ast.walk(tree):
            if isinstance(n, ast.Name) and n.id == old and isinstance(n.ctx, ast.Load):
                positions.add((n.lineno, len(original[n.lineno-1].encode("utf8")[:n.col_offset].decode("utf8"))))
        tokens = list(tokenize.generate_tokens(io.StringIO(text).readline))
        for n in defs if path == origin else []:
            # There may be other oldName tokens on the same line: find the one
            # immediately after the def/class header keyword.
            head = [t for t in tokens if t.start[0] == n.lineno and t.type == tokenize.NAME]
            for a, b in zip(head, head[1:]):
                if a.string in ("def", "class") and b.string == old:
                    positions.add(b.start)
                    break
            else:
                raise ValueError("definition token not found")
        for n, alias in imports:
            possible = [t for t in tokens if t.type == tokenize.NAME and t.string == old
                        and n.lineno <= t.start[0] <= n.end_lineno]
            if len(possible) != 1:
                raise ValueError("import token ambiguous")
            positions.add(possible[0].start)
        permitted = [t for t in tokens if t.type == tokenize.NAME and t.string == old and t.start in positions]
        if len(permitted) != len(positions):
            raise ValueError("AST/token coordinates disagree")
        for t in sorted(permitted, key=lambda t: t.start, reverse=True):
            row, col = t.start
            line = original[row-1]
            if line[col:col+len(old)] != old:
                raise ValueError("token mismatch")
            original[row-1] = line[:col] + new + line[col+len(old):]
        updated = "".join(original)
        ast.parse(updated, filename=path)
        if updated != text:
            changes.append({"path":path, "oldText":text, "newText":updated,
                            "occurrences":len(positions)})
    if not origin_found or not changes:
        raise ValueError("no unambiguous edits")
    return {"backend":"python-ast-scoped", "bindingResolved":False,
            "projectCoverage":"explicit-paths-only", "manualReviewRequired":True,
            "changes":changes, "filesScanned":len(files)}

def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("replace","rename"):
        raise ValueError("unknown AST action")
    raw = sys.stdin.buffer.read(MAX_TOTAL+1)
    if len(raw) > MAX_TOTAL:
        raise ValueError("AST transformation input exceeds 1 MiB")
    args = json.loads(raw)
    answer = replace_symbol(args) if sys.argv[1] == "replace" else rename(args)
    print(json.dumps(answer, ensure_ascii=False))

if __name__ == "__main__":
    try: main()
    except (ValueError, TypeError, KeyError, SyntaxError, UnicodeDecodeError) as exc:
        print(str(exc)[:300], file=sys.stderr)
        sys.exit(1)
