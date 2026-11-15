package egress

import (
	"context"
	"encoding/json"
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

// A stack's game and its services share the server's bridge: same-bridge traffic must be accepted before any reject
// (other bridges, private destinations) and after the restricted check, so a db on 172.x stays reachable from its
// game while everything else private is refused.
func TestRulesetAllowsIntraBridgeFirst(t *testing.T) {
	script, err := Ruleset(TableName, []string{"gss-a"})
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(script, "chain forward {")
	end := start + strings.Index(script[start:], "\n\t}")
	forward := script[start:end]
	restricted := strings.Index(forward, "iifname != @restricted accept")
	intra := strings.Index(forward, "iifname . oifname @intra accept")
	reject := strings.Index(forward, "reject")
	if restricted < 0 || intra < 0 || reject < 0 || !(restricted < intra && intra < reject) {
		t.Fatalf("forward chain must accept non-restricted, then same-bridge traffic, before any reject:\n%s", forward)
	}
	add, err := AddScript(TableName, []string{"gss-a"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(add, `add element inet ionnet_gss intra { "gss-a" . "gss-a" }`) {
		t.Fatalf("an incremental add must also allow same-bridge traffic:\n%s", add)
	}
}

// fakeRunner records scripts and fails while fail is set, or for incremental adds while addFails is set. Lists
// answer with the bridges of the last rebuild, minus the table when gone is set.
type fakeRunner struct {
	scripts  []string
	lists    int
	fail     error
	addFails bool
	gone     bool
	kernel   []string // bridges in the "kernel" table
}

func (r *fakeRunner) run(_ context.Context, script string, list bool) (string, error) {
	if list {
		r.lists++
		if r.fail != nil {
			return "", r.fail
		}
		if r.gone {
			return "Error: No such file or directory", errors.New("nft refused the ruleset (exit 1): Error: No such file or directory")
		}
		return fakeListing(TableName, r.kernel), nil
	}
	r.scripts = append(r.scripts, script)
	if r.fail != nil {
		return "", r.fail
	}
	if r.addFails && strings.HasPrefix(script, "add element") {
		return "", errors.New("Error: No such file or directory")
	}
	if strings.HasPrefix(script, "add table") {
		r.gone = false
		r.kernel = nil
		if i := strings.Index(script, "set restricted {"); i >= 0 {
			block := script[i : i+strings.Index(script[i:], "}")]
			if j := strings.Index(block, "elements = { "); j >= 0 {
				for _, name := range strings.Split(block[j+len("elements = { "):], ", ") {
					r.kernel = append(r.kernel, strings.Trim(strings.TrimSpace(name), `"`))
				}
			}
		}
	} else if strings.HasPrefix(script, "add element") {
		start := strings.Index(script, "{ ") + 2
		for _, name := range strings.Split(script[start:strings.Index(script, " }")], ", ") {
			r.kernel = append(r.kernel, strings.Trim(name, `"`))
		}
	}
	return "", nil
}

// fakeListing is what `nft -j list table` prints for a table Ruleset wrote with bridges.
func fakeListing(table string, bridges []string) string {
	entries := []map[string]any{
		{"metainfo": map[string]any{"json_schema_version": 1}},
		{"table": map[string]any{"family": "inet", "name": table, "comment": commentPrefix + Revision(table)}},
		{"chain": map[string]any{"name": "forward", "hook": "forward", "prio": -10}},
		{"chain": map[string]any{"name": "input", "hook": "input", "prio": -10}},
	}
	names, pairs := []any{}, []any{}
	for _, name := range bridges {
		names = append(names, name)
		pairs = append(pairs, map[string]any{"concat": []string{name, name}})
	}
	private4, private6 := []any{}, []any{}
	for range PrivateIPv4 {
		private4 = append(private4, map[string]any{"prefix": map[string]any{}})
	}
	for range PrivateIPv6 {
		private6 = append(private6, "::")
	}
	entries = append(entries,
		map[string]any{"set": map[string]any{"name": "restricted", "elem": names}},
		map[string]any{"set": map[string]any{"name": "intra", "elem": pairs}},
		map[string]any{"set": map[string]any{"name": "private4", "elem": private4}},
		map[string]any{"set": map[string]any{"name": "private6", "elem": private6}},
	)
	for i := 0; i < 3+len(otherBridges)+2; i++ {
		entries = append(entries, map[string]any{"rule": map[string]any{"chain": "forward"}})
	}
	for i := 0; i < 4; i++ {
		entries = append(entries, map[string]any{"rule": map[string]any{"chain": "input"}})
	}
	raw, _ := json.Marshal(map[string]any{"nftables": entries})
	return string(raw)
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

// Heal checks the kernel's table every time: a vanished table, a table of another agent version and a bridge
// missing from the set are all rebuilt, and a healthy table is only listed.
func TestHealRebuildsDrift(t *testing.T) {
	ctx := context.Background()
	runner := &fakeRunner{}
	f := New(Options{Run: runner.run})
	f.Heal(ctx)
	if runner.lists != 0 || len(runner.scripts) != 0 {
		t.Fatal("heal before the first sync touched nft")
	}
	if err := f.Sync(ctx, map[string]string{"a": "gss-a", "b": "gss-b"}); err != nil {
		t.Fatal(err)
	}
	f.Heal(ctx)
	if runner.lists != 1 || len(runner.scripts) != 1 {
		t.Fatalf("heal of a matching table: %d lists, %d scripts", runner.lists, len(runner.scripts))
	}
	runner.gone = true
	f.Heal(ctx)
	if len(runner.scripts) != 2 || runner.gone || !strings.Contains(runner.scripts[1], `"gss-a", "gss-b"`) {
		t.Fatalf("heal did not rebuild a missing table: %d scripts", len(runner.scripts))
	}
	if facts := f.Facts(); !facts.Filtering || facts.Error != nil || facts.Restricted != 2 {
		t.Fatalf("facts after rebuilding: %+v", facts)
	}
	runner.kernel = []string{"gss-a"}
	f.Heal(ctx)
	if len(runner.scripts) != 3 {
		t.Fatal("heal did not rebuild a table with a bridge missing")
	}
	// A rebuild that fails leaves the facts saying so, with the cause.
	runner.gone, runner.fail = true, errors.New("helper image missing")
	f.Heal(ctx)
	if facts := f.Facts(); facts.Filtering || facts.Error == nil || !strings.Contains(*facts.Error, "helper image missing") {
		t.Fatalf("facts after a failed check: %+v", facts)
	}
	runner.fail = nil
	f.Heal(ctx)
	if facts := f.Facts(); !facts.Filtering {
		t.Fatalf("facts after recovering: %+v", facts)
	}
}

func TestCheckListing(t *testing.T) {
	ok := fakeListing(TableName, []string{"gss-b", "gss-a"})
	if err := checkListing(ok, TableName, []string{"gss-a", "gss-b"}); err != nil {
		t.Fatal(err)
	}
	if err := checkListing(ok, TableName, []string{"gss-a"}); err == nil {
		t.Error("an extra bridge in the kernel went unnoticed")
	}
	old := strings.Replace(ok, Revision(TableName), "000000000000", 1)
	if err := checkListing(old, TableName, []string{"gss-a", "gss-b"}); err == nil {
		t.Error("a table of another revision went unnoticed")
	}
	if err := checkListing(`{"nftables": [{"metainfo": {}}]}`, TableName, nil); !errors.Is(err, errTableMissing) {
		t.Errorf("an empty listing: %v", err)
	}
}

// The IPv6 private set embeds the IPv4 ranges in NAT64 and leaves public NAT64 destinations alone.
func TestPrivateIPv6(t *testing.T) {
	joined := strings.Join(PrivateIPv6, " ")
	for _, want := range []string{"64:ff9b::a00:0/104", "64:ff9b::c0a8:0/112", "64:ff9b::a9fe:0/112", "2002::/16", "::/96"} {
		if !strings.Contains(joined, want) {
			t.Errorf("private6 is missing %s: %s", want, joined)
		}
	}
	if strings.Contains(joined, "64:ff9b::/96") {
		t.Error("private6 must not refuse all of NAT64")
	}
}
