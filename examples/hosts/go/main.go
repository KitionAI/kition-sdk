// Opens a workspace file in its kit, runs one command, and saves it, through `kition-kits serve`.
//
//	go run . <kition-kits> <workspace> <kits-dir> <file> <command> '<params as JSON>'
//
// Go's standard library is all it needs: the service speaks JSON-RPC 2.0, one message per line,
// on the process's standard input and output (docs/sdk/hosts.md).
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
)

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Reason string `json:"reason"`
	} `json:"data"`
}

func (e *rpcError) Error() string { return e.Message }

type kits struct {
	cmd  *exec.Cmd
	in   io.WriteCloser
	out  *bufio.Scanner
	next int
}

func start(executable, workspace, kitsDir string) (*kits, error) {
	cmd := exec.Command(executable, "serve", "--workspace", workspace, "--kits-dir", kitsDir)
	cmd.Stderr = os.Stderr
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	scanner := bufio.NewScanner(out)
	scanner.Buffer(make([]byte, 64*1024), 64<<20) // a message may be up to 64 MiB
	return &kits{cmd: cmd, in: in, out: scanner}, cmd.Start()
}

// call sends one request and reads its answer: one request at a time, so the next line is it.
func (k *kits) call(method string, params map[string]any, result any) error {
	k.next++
	request, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": k.next, "method": method, "params": params})
	if _, err := k.in.Write(append(request, '\n')); err != nil {
		return err
	}
	if !k.out.Scan() {
		return fmt.Errorf("kition-kits closed: %v", k.out.Err())
	}
	var answer struct {
		Result json.RawMessage `json:"result"`
		Error  *rpcError       `json:"error"`
	}
	if err := json.Unmarshal(k.out.Bytes(), &answer); err != nil {
		return err
	}
	if answer.Error != nil {
		return answer.Error
	}
	if result == nil {
		return nil
	}
	return json.Unmarshal(answer.Result, result)
}

type document struct {
	KitID      string `json:"kitId"`
	DocumentID string `json:"documentId"`
	Path       string `json:"path"`
	Dirty      bool   `json:"dirty"`
}

func main() {
	executable, workspace, kitsDir, file, command, params := os.Args[1], os.Args[2], os.Args[3], os.Args[4], os.Args[5], os.Args[6]
	k, err := start(executable, workspace, kitsDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer func() { k.in.Close(); k.cmd.Wait() }()
	var opened, saved document
	var commandParams map[string]any
	_ = json.Unmarshal([]byte(params), &commandParams)
	err = k.call("kits.initialize", map[string]any{"client": map[string]string{"name": "go-example", "version": "1"}}, nil)
	if err == nil {
		err = k.call("documents.open", map[string]any{"path": file}, &opened)
	}
	target := map[string]any{"kit": opened.KitID, "documentId": opened.DocumentID}
	if err == nil {
		err = k.call("command.execute", map[string]any{"kit": opened.KitID, "documentId": opened.DocumentID, "command": command, "params": commandParams, "origin": "system"}, nil)
	}
	if err == nil {
		err = k.call("documents.save", target, &saved)
	}
	if e, ok := err.(*rpcError); ok {
		out, _ := json.Marshal(map[string]any{"error": e.Data.Reason})
		fmt.Println(string(out))
		return
	} else if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	out, _ := json.Marshal(map[string]any{"path": saved.Path, "dirty": saved.Dirty})
	fmt.Println(string(out))
}
