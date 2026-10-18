#!/usr/bin/env python3
import ast
import json
import sys

def main():
    args=json.load(sys.stdin)
    text=args["text"]
    symbol=args["symbol"]
    new_text=args["newText"]
    tree=ast.parse(text)
    replacement=ast.parse(new_text)
    if len(replacement.body)!=1 or not isinstance(replacement.body[0],(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)):
        raise ValueError("replacement must be exactly one function or class definition")
    replacement_symbol=replacement.body[0].name
    if replacement_symbol!=symbol: raise ValueError("replacement symbol must retain its declared name")
    matches=[node for node in tree.body if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)) and node.name==symbol]
    if len(matches)!=1: raise ValueError("expected exactly one top-level symbol")
    node=matches[0]
    original=text.splitlines(keepends=True)
    begin=node.lineno-1
    end=node.end_lineno
    # Decorators are part of a definition and must not be silently discarded.
    if node.decorator_list: begin=min(d.lineno for d in node.decorator_list)-1
    old=''.join(original[begin:end])
    if not old: raise ValueError("empty source")
    adjusted=new_text.rstrip('\n')+'\n'
    candidate=''.join(original[:begin])+adjusted+''.join(original[end:])
    ast.parse(candidate)
    if candidate.count(adjusted)!=1 or text.count(old)!=1: raise ValueError("ambiguous replacement")
    print(json.dumps({"oldText":old,"newText":adjusted}))
if __name__=="__main__":
    try: main()
    except Exception as e:
        print(str(e),file=sys.stderr)
        sys.exit(1)
