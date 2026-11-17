#!/usr/bin/env python3
"""Opens a workspace file in its kit, runs one command, and saves it, through `kition-kits serve`.

    python3 edit.py <kition-kits> <workspace> <kits-dir> <file> <command> '<params as JSON>'

Python's standard library is all it needs: the service speaks JSON-RPC 2.0, one message per line,
on the process's standard input and output (docs/sdk/hosts.md).
"""
import itertools
import json
import subprocess
import sys


class KitsError(Exception):
    def __init__(self, error):
        super().__init__(error.get("message"))
        self.code = error.get("code")
        self.reason = (error.get("data") or {}).get("reason")


class Kits:
    def __init__(self, executable, workspace, kits_dir):
        command = [executable, "serve", "--workspace", workspace, "--kits-dir", kits_dir]
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.ids = itertools.count(1)

    def call(self, method, **params):
        request = {"jsonrpc": "2.0", "id": next(self.ids), "method": method, "params": params}
        self.process.stdin.write(json.dumps(request) + "\n")
        self.process.stdin.flush()
        # One request at a time, so the next line is its answer.
        answer = json.loads(self.process.stdout.readline())
        if "error" in answer:
            raise KitsError(answer["error"])
        return answer["result"]

    def close(self):
        self.process.stdin.close()
        self.process.wait()


def main(executable, workspace, kits_dir, file, command, params):
    kits = Kits(executable, workspace, kits_dir)
    try:
        kits.call("kits.initialize", client={"name": "python-example", "version": "1"})
        document = kits.call("documents.open", path=file)
        target = {"kit": document["kitId"], "documentId": document["documentId"]}
        kits.call("commands.execute", command=command, params=json.loads(params), origin="system", **target)
        saved = kits.call("documents.save", **target)
        print(json.dumps({"path": saved["path"], "dirty": saved["dirty"]}))
    except KitsError as error:
        print(json.dumps({"error": error.reason or error.code}))
    finally:
        kits.close()


if __name__ == "__main__":
    main(*sys.argv[1:7])
