package steps

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/initd/datafs"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/version"
)

// DOWNLOAD_ATTEMPTS is how often a download is tried on network errors and 5xx/429 answers.
const DOWNLOAD_ATTEMPTS = 3

// downloadClient has no overall timeout (game files are large); stalls are bounded by the transport timeouts and
// cancelled through the context.
var downloadClient = &http.Client{
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   30 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
		IdleConnTimeout:       90 * time.Second,
	},
}

type downloadStep struct{}

func (downloadStep) Name() string { return "download" }

func (downloadStep) Matches(step protocol.InstallStep) bool { return step.Download != nil }

func (downloadStep) Describe(step protocol.InstallStep) string {
	return fmt.Sprintf("%s from %s", step.Download.File, redactURL(step.Download.URL))
}

func (downloadStep) Run(ctx context.Context, step protocol.InstallStep, env Env) error {
	d := step.Download
	dest, err := datafs.Rel(d.File)
	if err != nil {
		return err
	}
	u, err := url.Parse(d.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("download URL %q must be an absolute http(s) URL", d.URL)
	}
	want := strings.ToLower(strings.TrimSpace(d.Sha256))
	if want != "" {
		if raw, err := hex.DecodeString(want); err != nil || len(raw) != sha256.Size {
			return fmt.Errorf("sha256 %q is not 64 hex characters", d.Sha256)
		}
	} else {
		fmt.Fprintf(env.Output, "No sha256 given for %s; the download is not verified.\n", dest)
	}
	if err := datafs.MkdirAll(env.Data, path.Dir(dest), env.UID); err != nil {
		return err
	}

	tmp := path.Join(path.Dir(dest), "."+path.Base(dest)+".gss-download")
	defer env.Data.Remove(tmp)
	var got string
	for attempt := 1; ; attempt++ {
		var retry bool
		got, retry, err = fetch(ctx, d.URL, env, tmp)
		if err == nil {
			break
		}
		if !retry || attempt >= DOWNLOAD_ATTEMPTS || ctx.Err() != nil {
			return err
		}
		wait := time.Duration(attempt*2) * time.Second
		fmt.Fprintf(env.Output, "%v; retrying in %s (attempt %d of %d).\n", err, wait, attempt+1, DOWNLOAD_ATTEMPTS)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
	if want != "" && got != want {
		return fmt.Errorf("sha256 mismatch for %s: expected %s, got %s", dest, want, got)
	}
	if err := datafs.Chown(env.Data, tmp, env.UID); err != nil {
		return err
	}
	if err := env.Data.Rename(tmp, dest); err != nil {
		return fmt.Errorf("move download into place: %w", err)
	}
	if want != "" {
		fmt.Fprintf(env.Output, "Saved %s (sha256 verified).\n", dest)
	} else {
		fmt.Fprintf(env.Output, "Saved %s (sha256 %s).\n", dest, got)
	}
	return nil
}

// fetch downloads rawURL into tmp and returns the hex sha256. retry reports whether the failure is worth another
// attempt (network errors, 5xx, 429).
func fetch(ctx context.Context, rawURL string, env Env, tmp string) (sum string, retry bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", false, err
	}
	req.Header.Set("User-Agent", "ionnet-gss-init/"+version.Version)
	resp, err := downloadClient.Do(req)
	if err != nil {
		return "", true, fmt.Errorf("download %s: %w", redactURL(rawURL), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		retry = resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests
		return "", retry, fmt.Errorf("download %s: HTTP %s", redactURL(rawURL), resp.Status)
	}

	f, err := env.Data.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return "", false, err
	}
	hash := sha256.New()
	progress := &progressWriter{out: env.Output, total: resp.ContentLength, last: time.Now()}
	_, copyErr := io.Copy(io.MultiWriter(f, hash, progress), resp.Body)
	closeErr := f.Close()
	if copyErr != nil {
		if ctx.Err() != nil {
			return "", false, ctx.Err()
		}
		return "", true, fmt.Errorf("download %s: %w", redactURL(rawURL), copyErr)
	}
	if closeErr != nil {
		return "", false, closeErr
	}
	progress.finish()
	return hex.EncodeToString(hash.Sum(nil)), false, nil
}

// progressWriter prints a progress line at most every 2 seconds.
type progressWriter struct {
	out   io.Writer
	total int64 // -1 when unknown
	done  int64
	last  time.Time
}

func (p *progressWriter) Write(b []byte) (int, error) {
	p.done += int64(len(b))
	if time.Since(p.last) >= 2*time.Second {
		p.last = time.Now()
		p.print()
	}
	return len(b), nil
}

func (p *progressWriter) finish() { p.print() }

func (p *progressWriter) print() {
	if p.total > 0 {
		fmt.Fprintf(p.out, "Downloaded %s of %s (%d%%)\n", megabytes(p.done), megabytes(p.total), p.done*100/p.total)
	} else {
		fmt.Fprintf(p.out, "Downloaded %s\n", megabytes(p.done))
	}
}

func megabytes(n int64) string { return fmt.Sprintf("%.1f MB", float64(n)/1e6) }

// redactURL drops credentials and query strings (tokens) from URLs shown in the console.
func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "(invalid URL)"
	}
	u.User = nil
	if u.RawQuery != "" {
		u.RawQuery = "…"
	}
	return u.String()
}
