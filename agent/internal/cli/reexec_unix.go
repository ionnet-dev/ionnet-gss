//go:build unix

package cli

import (
	"os"
	"syscall"
)

// reexec replaces this process with the binary at exe, same PID, arguments and environment, so systemd (and a
// shell that ran it by hand) keep the same process. Returns only on failure.
func reexec(exe string) error {
	return syscall.Exec(exe, os.Args, os.Environ())
}
