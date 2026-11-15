package steps

import (
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/initd/datafs"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// STEAMCMD_ATTEMPTS is how often a steamcmd run is tried before a failure is final. steamcmd often fails right
// after it updated itself, and a re-run resumes where the last one stopped.
const STEAMCMD_ATTEMPTS = 3

// STEAMCMD_PROGRESS_EVERY is the shortest gap between two progress lines of the same phase in the console.
const STEAMCMD_PROGRESS_EVERY = 5 * time.Second

// STEAMCMD_READY marks a complete steamcmd bootstrap inside INIT_STEAMCMD_DIR (an interrupted extract has none and
// is redone).
const STEAMCMD_READY = ".gss-bootstrapped"

var (
	steamBetaPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	// steamcmd re-tokenises its command line, so the install folder is limited to characters that need no quoting.
	steamDirPattern = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)
)

// steamcmdStep installs or updates a Steam app with this server's own steamcmd (INIT_STEAMCMD_DIR), bootstrapped
// from STEAMCMD_URL on first use. Login is always anonymous. steamcmd runs as the game user.
type steamcmdStep struct{}

func (steamcmdStep) Name() string { return "steamcmd" }

func (steamcmdStep) Matches(step protocol.InstallStep) bool { return step.Steamcmd != nil }

func (steamcmdStep) Describe(step protocol.InstallStep) string {
	s := step.Steamcmd
	var extra []string
	if s.Beta != "" {
		extra = append(extra, "beta "+s.Beta)
	}
	if s.Validate {
		extra = append(extra, "validate")
	}
	text := fmt.Sprintf("app %d", s.App)
	if len(extra) > 0 {
		text += " (" + strings.Join(extra, ", ") + ")"
	}
	dir := "/data"
	if s.Dir != "" {
		if rel, err := datafs.Rel(s.Dir); err == nil && rel != "." {
			dir = "/data/" + rel
		}
	}
	return text + " into " + dir
}

func (steamcmdStep) Run(ctx context.Context, step protocol.InstallStep, env Env) error {
	s := step.Steamcmd
	if s.App <= 0 {
		return fmt.Errorf("steamcmd app %d is not a Steam app id", s.App)
	}
	if s.Beta != "" && !steamBetaPattern.MatchString(s.Beta) {
		return fmt.Errorf("steamcmd beta %q may only use letters, digits, `.`, `_` and `-`", s.Beta)
	}
	steamDir, err := datafs.Rel(protocol.InitSteamcmdDir)
	if err != nil {
		return err
	}
	installDir := "."
	if s.Dir != "" {
		if installDir, err = datafs.Rel(s.Dir); err != nil {
			return err
		}
		if installDir != "." && !steamDirPattern.MatchString(installDir) {
			return fmt.Errorf("steamcmd dir %q may only use letters, digits, `.`, `_`, `-` and `/`", s.Dir)
		}
	}
	if gss := path.Dir(steamDir); installDir == gss || strings.HasPrefix(installDir, gss+"/") {
		return fmt.Errorf("steamcmd dir %q is inside gss-init's own folder /data/%s; pick another folder", s.Dir, gss)
	}

	fresh, err := bootstrapSteamcmd(ctx, env, steamDir)
	if err != nil {
		return err
	}
	if err := datafs.MkdirAll(env.Data, installDir, env.UID); err != nil {
		return fmt.Errorf("create the install folder: %w", err)
	}
	script := filepath.Join(env.DataPath, steamDir, "steamcmd.sh")
	// steamcmd keeps its state (~/Steam: app cache, logs, config) in HOME; that belongs in its own folder, not in
	// the game's /data.
	steamEnv := env
	steamEnv.Vars = map[string]string{}
	for k, v := range env.Vars {
		steamEnv.Vars[k] = v
	}
	steamEnv.Vars["HOME"] = filepath.Join(env.DataPath, steamDir)
	if fresh {
		fmt.Fprintln(env.Output, "Updating steamcmd itself (first run).")
		if err := retrySteamcmd(ctx, steamEnv, s.App, script, []string{"+@ShutdownOnFailedCommand", "1", "+quit"}, nil); err != nil {
			return fmt.Errorf("steamcmd could not update itself: %w", err)
		}
	}

	args := []string{
		"+@ShutdownOnFailedCommand", "1",
		"+@NoPromptForPassword", "1",
		"+force_install_dir", filepath.Join(env.DataPath, installDir),
		"+login", "anonymous",
		"+app_update", strconv.FormatInt(s.App, 10),
	}
	if s.Beta != "" {
		args = append(args, "-beta", s.Beta)
	}
	if s.Validate {
		args = append(args, "validate")
	}
	args = append(args, "+quit")
	verify := func() error { return checkAppManifest(env, installDir, s.App) }
	if err := retrySteamcmd(ctx, steamEnv, s.App, script, args, verify); err != nil {
		return err
	}
	return linkSteamClient(env, steamDir)
}

// linkSteamClient points ~/.steam/sdk32 and sdk64 (HOME is /data for the game) at steamcmd's steamclient.so, where
// Steamworks game servers look for it. Existing entries are left alone.
func linkSteamClient(env Env, steamDir string) error {
	for sdk, arch := range map[string]string{"sdk32": "linux32", "sdk64": "linux64"} {
		target := path.Join(steamDir, arch, "steamclient.so")
		if _, err := env.Data.Stat(target); err != nil {
			continue
		}
		link := path.Join(".steam", sdk, "steamclient.so")
		if _, err := env.Data.Lstat(link); err == nil {
			continue
		}
		if err := datafs.MkdirAll(env.Data, path.Dir(link), env.UID); err != nil {
			return fmt.Errorf("link steamclient.so: %w", err)
		}
		if err := env.Data.Symlink(filepath.Join(env.DataPath, target), link); err != nil {
			return fmt.Errorf("link steamclient.so: %w", err)
		}
		if err := datafs.Chown(env.Data, link, env.UID); err != nil {
			return err
		}
	}
	return nil
}

// bootstrapSteamcmd downloads and unpacks steamcmd into dir (below the data folder) unless a complete copy is
// already there. fresh reports a new copy, which still has to update itself.
func bootstrapSteamcmd(ctx context.Context, env Env, dir string) (fresh bool, err error) {
	if err := datafs.MkdirAll(env.Data, dir, env.UID); err != nil {
		return false, fmt.Errorf("create the steamcmd folder: %w", err)
	}
	// steamcmd updates itself in place as the game user, whoever created the folder.
	if err := datafs.Chown(env.Data, dir, env.UID); err != nil {
		return false, err
	}
	if _, err := env.Data.Stat(path.Join(dir, STEAMCMD_READY)); err == nil {
		return false, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return false, err
	}

	u, err := url.Parse(protocol.SteamcmdURL)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return false, fmt.Errorf("STEAMCMD_URL %q must be an https URL", protocol.SteamcmdURL)
	}
	fmt.Fprintf(env.Output, "Downloading steamcmd from %s.\n", redactURL(protocol.SteamcmdURL))
	tmp := path.Join(dir, ".steamcmd_linux.tar.gz.gss-download")
	defer env.Data.Remove(tmp)
	if _, err := fetchWithRetry(ctx, protocol.SteamcmdURL, env, tmp); err != nil {
		return false, fmt.Errorf("download steamcmd: %w", err)
	}
	f, err := env.Data.Open(tmp)
	if err != nil {
		return false, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return false, fmt.Errorf("unpack steamcmd: %w", err)
	}
	x := &extractor{root: env.Data, to: dir, uid: env.UID}
	if err := x.tar(ctx, gz); err != nil {
		return false, fmt.Errorf("unpack steamcmd: %w", err)
	}
	if info, err := env.Data.Stat(path.Join(dir, "steamcmd.sh")); err != nil || !info.Mode().IsRegular() {
		return false, fmt.Errorf("the steamcmd download from %s has no steamcmd.sh", redactURL(protocol.SteamcmdURL))
	}
	if err := datafs.WriteFile(env.Data, path.Join(dir, STEAMCMD_READY), []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644, env.UID); err != nil {
		return false, err
	}
	fmt.Fprintf(env.Output, "steamcmd unpacked (%d files) into /data/%s.\n", x.files, dir)
	return true, nil
}

// retrySteamcmd runs steamcmd until it succeeds, fails in a way a re-run can't fix, or STEAMCMD_ATTEMPTS ran.
// verify (optional) checks a run that looked successful, because steamcmd also prints "Success!" and exits 0 when
// it gave up.
func retrySteamcmd(ctx context.Context, env Env, app int64, script string, args []string, verify func() error) error {
	for attempt := 1; ; attempt++ {
		out := newSteamcmdOutput(env.Output)
		code, err := RunProgram(ctx, env, append([]string{script}, args...), nil, out, nil)
		out.Flush()
		if err != nil {
			return err
		}
		permanent, failure := out.failure(app, code)
		if failure == nil && verify != nil {
			failure = verify()
			var final *permanentError
			permanent = errors.As(failure, &final)
		}
		if failure == nil {
			return nil
		}
		if permanent || attempt >= STEAMCMD_ATTEMPTS {
			return failure
		}
		wait := time.Duration(attempt*5) * time.Second
		fmt.Fprintf(env.Output, "%v; retrying in %s (attempt %d of %d).\n", failure, wait, attempt+1, STEAMCMD_ATTEMPTS)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
}

var (
	ansiPattern = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]`)
	// Example:
	// Update state (0x61) downloading, progress: 42.17 (1228632441 / 2913507328)
	updateStatePattern = regexp.MustCompile(`^Update state \(0x[0-9a-fA-F]+\) ([^,]+), progress: ([0-9.]+) \((\d+) / (\d+)\)`)
	// Example:
	// [ 45%] Downloading update (19,456 of 43,235 KB)...
	selfUpdatePattern = regexp.MustCompile(`^\[(\s*\d+%|----)\]`)
	digitsPattern     = regexp.MustCompile(`[0-9][0-9,.]*`)
	// Examples:
	// Error! App '4020' state is 0x202 after update job.
	// Logging in user 'anonymous' to Steam Public...FAILED (Rate Limit Exceeded)
	// Update state (0x0) : Timed out waiting for update to start, bailing.
	steamErrorPattern = regexp.MustCompile(`(?i)^error!|\.\.\.FAILED\b|^ERROR \(|Timed out waiting for update|, bailing`)
)

// steamcmdOutput turns steamcmd's output into readable console lines: `\r` and `\n` both end a line, terminal escape
// sequences are dropped, progress lines of one phase are shown at most every STEAMCMD_PROGRESS_EVERY (the last one
// always), and the lines that say why a run failed are remembered.
type steamcmdOutput struct {
	mu        sync.Mutex
	out       io.Writer
	buf       []byte
	phase     string    // phase of the last progress line shown
	shown     time.Time // when it was shown
	pending   string    // a progress line held back by the rate limit
	errorLine string
}

func newSteamcmdOutput(out io.Writer) *steamcmdOutput { return &steamcmdOutput{out: out} }

func (o *steamcmdOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	for _, b := range p {
		if b == '\r' || b == '\n' || len(o.buf) >= protocol.ConsoleLineMaxBytes {
			o.lineLocked(string(o.buf))
			o.buf = o.buf[:0]
			if b == '\r' || b == '\n' {
				continue
			}
		}
		o.buf = append(o.buf, b)
	}
	return len(p), nil
}

// Flush ends a partial last line and shows a held-back progress line.
func (o *steamcmdOutput) Flush() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.lineLocked(string(o.buf))
	o.buf = o.buf[:0]
	o.showPendingLocked()
}

func (o *steamcmdOutput) lineLocked(raw string) {
	text := strings.TrimSpace(ansiPattern.ReplaceAllString(raw, ""))
	if text == "" {
		return
	}
	if m := updateStatePattern.FindStringSubmatch(text); m != nil {
		done, _ := strconv.ParseInt(m[3], 10, 64)
		total, _ := strconv.ParseInt(m[4], 10, 64)
		o.progressLocked(m[1], fmt.Sprintf("Update state: %s %s%% (%s of %s)", m[1], m[2], sizeText(done), sizeText(total)))
		return
	}
	if loc := selfUpdatePattern.FindStringIndex(text); loc != nil {
		o.progressLocked(digitsPattern.ReplaceAllString(text[loc[1]:], ""), text)
		return
	}
	o.showPendingLocked()
	if steamErrorPattern.MatchString(text) {
		o.errorLine = text
	}
	fmt.Fprintln(o.out, text)
}

func (o *steamcmdOutput) progressLocked(phase, text string) {
	if phase != o.phase {
		o.showPendingLocked() // the last line of the previous phase
	}
	if phase != o.phase || time.Since(o.shown) >= STEAMCMD_PROGRESS_EVERY {
		o.phase, o.shown, o.pending = phase, time.Now(), ""
		fmt.Fprintln(o.out, text)
		return
	}
	o.pending = text
}

func (o *steamcmdOutput) showPendingLocked() {
	if o.pending != "" {
		fmt.Fprintln(o.out, o.pending)
		o.pending = ""
		o.shown = time.Now()
	}
}

// failure explains a finished run: nil when it succeeded; permanent when running it again can't help.
func (o *steamcmdOutput) failure(app int64, code int) (permanent bool, err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if code == 0 && o.errorLine == "" {
		return false, nil
	}
	said := o.errorLine
	switch {
	case strings.Contains(said, "No subscription"):
		return true, fmt.Errorf("app %d can't be downloaded with an anonymous login (Steam says %q); only anonymous installs are supported, so use the app id of the game's dedicated server", app, said)
	case strings.Contains(said, "Invalid platform"):
		return true, fmt.Errorf("app %d has no Linux version (Steam says %q)", app, said)
	case strings.Contains(said, "0x202") || strings.Contains(said, "Not enough disk space"):
		return true, fmt.Errorf("not enough disk space for app %d (Steam says %q); free space in the data folder or raise the server's disk quota", app, said)
	case strings.Contains(said, "Disk write failure"):
		return true, fmt.Errorf("steamcmd could not write the files of app %d (Steam says %q); check free space and that the game user owns the install folder", app, said)
	case strings.Contains(said, "Timed out waiting for update"):
		return false, fmt.Errorf("steamcmd gave up on app %d (Steam says %q); if this repeats, the app probably can't be downloaded anonymously, so check that the id is the game's dedicated server", app, said)
	case said == "":
		return false, fmt.Errorf("steamcmd exited with code %d", code)
	case code == 0:
		return false, fmt.Errorf("steamcmd reported: %s", said)
	}
	return false, fmt.Errorf("steamcmd exited with code %d: %s", code, said)
}

// Example (steamapps/appmanifest_1007.acf):
//
//	"StateFlags"		"4"
//	"buildid"		"25329704"
var (
	manifestFlagsPattern = regexp.MustCompile(`"StateFlags"\s+"(\d+)"`)
	manifestBuildPattern = regexp.MustCompile(`"buildid"\s+"(\d+)"`)
	manifestSizePattern  = regexp.MustCompile(`"SizeOnDisk"\s+"(\d+)"`)
)

// permanentError is a verify failure that another steamcmd run can't fix.
type permanentError struct{ error }

func (e *permanentError) Unwrap() error { return e.error }

// Steam app state flags.
const (
	STEAM_STATE_UPDATE_REQUIRED = 2
	STEAM_STATE_FULLY_INSTALLED = 4
)

// checkAppManifest confirms steamcmd really installed app: its manifest in installDir says fully installed.
func checkAppManifest(env Env, installDir string, app int64) error {
	name := path.Join(installDir, "steamapps", fmt.Sprintf("appmanifest_%d.acf", app))
	raw, err := env.Data.ReadFile(name)
	if err != nil {
		return fmt.Errorf("steamcmd reported success but app %d has no manifest (/data/%s); when this repeats, the app probably can't be downloaded anonymously, so check that the id is the game's dedicated server", app, path.Clean(name))
	}
	state := "missing"
	flags := 0
	if m := manifestFlagsPattern.FindSubmatch(raw); m != nil {
		state = string(m[1])
		flags, _ = strconv.Atoi(state)
	}
	if flags&STEAM_STATE_FULLY_INSTALLED == 0 || flags&STEAM_STATE_UPDATE_REQUIRED != 0 {
		return fmt.Errorf("steamcmd finished but app %d is not fully installed (manifest StateFlags %s)", app, state)
	}
	if m := manifestSizePattern.FindSubmatch(raw); m != nil && string(m[1]) == "0" {
		return &permanentError{fmt.Errorf("steamcmd installed no files for app %d (Steam gives an anonymous login no depots of it); the app can't be downloaded anonymously, so use the app id of the game's dedicated server", app)}
	}
	build := "unknown"
	if b := manifestBuildPattern.FindSubmatch(raw); b != nil {
		build = string(b[1])
	}
	fmt.Fprintf(env.Output, "App %d is installed (build %s).\n", app, build)
	return nil
}

// sizeText formats a byte count for progress lines.
func sizeText(n int64) string {
	switch {
	case n >= 1e9:
		return fmt.Sprintf("%.2f GB", float64(n)/1e9)
	case n >= 1e6:
		return fmt.Sprintf("%.1f MB", float64(n)/1e6)
	}
	return fmt.Sprintf("%.0f kB", float64(n)/1e3)
}
