//go:build !unix

package cli

import "errors"

// reexec is only possible on Unix; hosts are Linux.
func reexec(exe string) error {
	return errors.New("restarting into an updated binary needs Linux; start gss-agent again by hand")
}
