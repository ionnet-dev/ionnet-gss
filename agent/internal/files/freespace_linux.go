package files

import "syscall"

// freeBytes is the space unprivileged writers may still use on dir's filesystem; ok is false when it can't be read.
func freeBytes(dir string) (free int64, ok bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, false
	}
	return int64(st.Bavail) * st.Bsize, true
}
