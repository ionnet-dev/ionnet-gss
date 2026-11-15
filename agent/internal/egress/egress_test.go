package egress

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestRulesetValidatesNames(t *testing.T) {
	for _, bad := range []string{"", "gss-0123456789ab", `x" ; flush ruleset`, "br-*", "a b", "-lead"} {
		if _, err := Ruleset(TableName, []string{bad}); err == nil {
			t.Errorf("Ruleset accepted the bridge name %q", bad)
		}
	}
	if _, err := Ruleset("bad table", nil); err == nil {
		t.Error("Ruleset accepted a bad table name")
	}
}

func TestRulesetShape(t *testing.T) {
	script, err := Ruleset(TableName, []string{"gss-b", "gss-a", "gss-a"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"add table inet ionnet_gss\ndelete table inet ionnet_gss\n",
		`elements = { "gss-a", "gss-b" }`,
		`elements = { "gss-a" . "gss-a", "gss-b" . "gss-b" }`,
		"type filter hook forward priority filter - 10; policy accept;\n\t\tct state established,related accept\n",
		"type filter hook input priority filter - 10; policy accept;",
		"169.254.0.0/16",
		"fc00::/7",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("ruleset is missing %q:\n%s", want, script)
		}
	}
	empty, err := Ruleset(TableName, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(empty, `elements = { "`) {
		t.Errorf("an empty ruleset lists bridge elements:\n%s", empty)
	}
}

// fakeRunner records scripts and fails while fail is set, or for incremental adds while addFails is set.
type fakeRunner struct {
	scripts  []string
	fail     error
	addFails bool
}

func (r *fakeRunner) run(_ context.Context, script string) (string, error) {
	r.scripts = append(r.scripts, script)
	if r.fail != nil {
		return "", r.fail
	}
	if r.addFails && strings.HasPrefix(script, "add element") {
		return "", errors.New("Error: No such file or directory")
	}
	return "", nil
}

func TestFirewallFlow(t *testing.T) {
	ctx := context.Background()
	runner := &fakeRunner{}
	f := New(Options{Run: runner.run})
	if f.Facts() != nil {
		t.Fatal("facts before the first apply should be nil")
	}
	if err := f.Sync(ctx, map[string]string{"a": "gss-a"}); err != nil {
		t.Fatal(err)
	}
	if facts := f.Facts(); facts == nil || !facts.Filtering || facts.Restricted != 1 {
		t.Fatalf("facts after sync: %+v", facts)
	}
	// Fresh after the sync: no second apply.
	if err := f.Restrict(ctx, "a", "gss-a"); err != nil || len(runner.scripts) != 1 {
		t.Fatalf("restrict of a fresh bridge ran nft again (%d scripts, %v)", len(runner.scripts), err)
	}
	// A new bridge is added incrementally.
	if err := f.Restrict(ctx, "b", "gss-b"); err != nil || !strings.HasPrefix(runner.scripts[len(runner.scripts)-1], "add element") {
		t.Fatalf("restrict b: %v, last script %q", err, runner.scripts[len(runner.scripts)-1])
	}
	// A missing table makes the add fail: the table is rebuilt with both bridges.
	runner.addFails = true
	if err := f.Restrict(ctx, "c", "gss-c"); err != nil {
		t.Fatal(err)
	}
	last := runner.scripts[len(runner.scripts)-1]
	if !strings.Contains(last, `"gss-a", "gss-b", "gss-c"`) {
		t.Fatalf("rebuild after a failed add lost bridges:\n%s", last)
	}
	runner.addFails = false
	// Failing applies make restricted starts fail and show in the facts; Heal recovers.
	runner.fail = errors.New("the helper image is missing")
	if err := f.Release(ctx, "c"); err == nil {
		t.Fatal("release with a broken runner should fail")
	}
	if err := f.Restrict(ctx, "a", "gss-a"); err == nil {
		t.Fatal("restrict with a broken runner should fail")
	}
	if facts := f.Facts(); facts.Filtering || facts.Error == nil {
		t.Fatalf("facts while broken: %+v", facts)
	}
	runner.fail = nil
	f.Heal(ctx)
	facts := f.Facts()
	if !facts.Filtering || facts.Restricted != 2 {
		t.Fatalf("facts after heal: %+v", facts)
	}
	if last := runner.scripts[len(runner.scripts)-1]; strings.Contains(last, "gss-c") || !strings.Contains(last, `"gss-a", "gss-b"`) {
		t.Fatalf("heal rebuilt the wrong set:\n%s", last)
	}
}
