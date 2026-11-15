package steps

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// Credential is the uid/gid a child runs as, or nil to keep gss-init's (uid < 0, or not running as root).
func Credential(uid int) *syscall.Credential {
	if uid < 0 || os.Geteuid() != 0 {
		return nil
	}
	return &syscall.Credential{Uid: uint32(uid), Gid: uint32(uid), Groups: []uint32{}}
}

// Environ is the environment for the game and hooks: gss-init's own (the image's ENV, e.g. PATH and JAVA_HOME),
// HOME/USER for the gss user, then the spec's env, then extra ("KEY=value") on top.
func Environ(dataPath string, vars map[string]string, extra ...string) []string {
	merged := map[string]string{}
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			merged[k] = v
		}
	}
	merged["HOME"] = dataPath
	merged["USER"] = "gss"
	merged["LOGNAME"] = "gss"
	for k, v := range vars {
		merged[k] = v
	}
	for _, kv := range extra {
		if k, v, ok := strings.Cut(kv, "="); ok {
			merged[k] = v
		}
	}
	keys := make([]string, 0, len(merged))
	for k := range merged {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+merged[k])
	}
	return out
}

// HookPath resolves a hook path from the spec (relative to FilesDir) and refuses paths that leave it.
func HookPath(filesDir, hook string) (string, error) {
	clean := path.Clean("/" + strings.TrimPrefix(hook, "/"))
	if clean == "/" {
		return "", fmt.Errorf("hook path %q is empty", hook)
	}
	full := filepath.Join(filesDir, clean)
	info, err := os.Stat(full)
	if err != nil {
		return "", fmt.Errorf("hook %s not found in the definition files (%s): %w", hook, filesDir, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("hook %s is not a regular file", hook)
	}
	return full, nil
}

// RunHook runs a hook script as env.UID in the data folder, with stdout and stderr to env.Output. Scripts with an
// executable bit run directly (their shebang decides), others through /bin/sh. The whole process group is killed
// when ctx ends, and stragglers are killed once the script exits.
func RunHook(ctx context.Context, hook string, env Env) error {
	full, err := HookPath(env.FilesDir, hook)
	if err != nil {
		return err
	}
	info, _ := os.Stat(full)
	argv := []string{"/bin/sh", full}
	if info != nil && info.Mode().Perm()&0o111 != 0 {
		argv = []string{full}
	}
	code, err := RunProgram(ctx, env, argv, nil, env.Output, nil)
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("hook %s exited with code %d", hook, code)
	}
	return nil
}

// RunProgram runs argv as env.UID in the data folder in its own process group and returns its exit code. stdin may
// be nil (/dev/null). stdout receives standard output; stderr receives standard error, or nil to merge it into
// stdout.
func RunProgram(ctx context.Context, env Env, argv []string, stdin *os.File, stdout, stderr io.Writer) (int, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = env.DataPath
	cmd.Env = Environ(env.DataPath, env.Vars)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Credential: Credential(env.UID)}
	if stdin != nil {
		cmd.Stdin = stdin
	}

	// exec.Cmd would copy non-file writers in goroutines that only cmd.Wait collects, so the pipes are ours.
	type stream struct {
		r, w *os.File
		to   io.Writer
	}
	var streams []stream
	open := func(to io.Writer) (*os.File, error) {
		r, w, err := os.Pipe()
		if err != nil {
			return nil, err
		}
		streams = append(streams, stream{r: r, w: w, to: to})
		return w, nil
	}
	closeAll := func(readers bool) {
		for _, st := range streams {
			st.w.Close()
			if readers {
				st.r.Close()
			}
		}
	}
	w, err := open(stdout)
	if err != nil {
		return -1, err
	}
	cmd.Stdout, cmd.Stderr = w, w
	if stderr != nil {
		if cmd.Stderr, err = open(stderr); err != nil {
			closeAll(true)
			return -1, err
		}
	}
	wait, err := env.Spawn(cmd)
	closeAll(false)
	if err != nil {
		closeAll(true)
		return -1, fmt.Errorf("start %s: %w", argv[0], err)
	}
	pid := cmd.Process.Pid

	copied := make(chan struct{}, len(streams))
	for _, st := range streams {
		go func() {
			_, _ = io.Copy(st.to, st.r)
			copied <- struct{}{}
		}()
	}
	exited := make(chan int, 1)
	go func() { exited <- wait() }()

	var code int
	select {
	case code = <-exited:
	case <-ctx.Done():
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		code = <-exited
	}
	// Background children of the program would keep the pipes open; they belong to the step and end with it.
	_ = syscall.Kill(-pid, syscall.SIGKILL)
	deadline := time.After(5 * time.Second) // a daemon in another session may still hold a pipe
	for range streams {
		select {
		case <-copied:
		case <-deadline:
		}
	}
	closeAll(true)
	if ctx.Err() != nil {
		return code, ctx.Err()
	}
	return code, nil
}
