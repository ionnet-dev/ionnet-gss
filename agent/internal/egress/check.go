package egress

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// errTableMissing: the listing found no table (someone flushed the ruleset or deleted it).
var errTableMissing = errors.New("the table is missing")

// ListScript lists the table; the helper runs it with `nft -j`.
func ListScript(table string) (string, error) {
	if err := ValidTable(table); err != nil {
		return "", err
	}
	return fmt.Sprintf("list table inet %s\n", table), nil
}

// nftListing is the part of `nft -j list table` the check reads.
type nftListing struct {
	Nftables []map[string]json.RawMessage `json:"nftables"`
}

type nftTable struct {
	Name    string `json:"name"`
	Comment string `json:"comment"`
}

type nftChain struct {
	Name string `json:"name"`
	Hook string `json:"hook"`
	Prio int    `json:"prio"`
}

type nftSet struct {
	Name string            `json:"name"`
	Elem []json.RawMessage `json:"elem"`
}

type nftRule struct {
	Chain string `json:"chain"`
}

// checkListing compares `nft -j list table inet <table>` with what Ruleset writes for bridges: the comment's
// revision (chains, rules and private ranges of this agent version), the base chains with their rule counts, the
// private sets' sizes and exactly the restricted bridges in both bridge sets. It returns why they differ, or nil.
func checkListing(output, table string, bridges []string) error {
	var listing nftListing
	if err := json.Unmarshal([]byte(output), &listing); err != nil {
		return fmt.Errorf("unreadable nft listing: %w", err)
	}
	var (
		found  bool
		chains = map[string]nftChain{}
		sets   = map[string]nftSet{}
		rules  = map[string]int{}
	)
	for _, entry := range listing.Nftables {
		switch {
		case entry["table"] != nil:
			var t nftTable
			if err := json.Unmarshal(entry["table"], &t); err != nil {
				return fmt.Errorf("unreadable table in the nft listing: %w", err)
			}
			if t.Name != table {
				continue
			}
			found = true
			if want := commentPrefix + Revision(table); t.Comment != want {
				return fmt.Errorf("the table is from another agent version or was edited (comment %q)", t.Comment)
			}
		case entry["chain"] != nil:
			var c nftChain
			if err := json.Unmarshal(entry["chain"], &c); err != nil {
				return fmt.Errorf("unreadable chain in the nft listing: %w", err)
			}
			chains[c.Name] = c
		case entry["set"] != nil:
			var set nftSet
			if err := json.Unmarshal(entry["set"], &set); err != nil {
				return fmt.Errorf("unreadable set in the nft listing: %w", err)
			}
			sets[set.Name] = set
		case entry["rule"] != nil:
			var r nftRule
			if err := json.Unmarshal(entry["rule"], &r); err != nil {
				return fmt.Errorf("unreadable rule in the nft listing: %w", err)
			}
			rules[r.Chain]++
		}
	}
	if !found {
		return errTableMissing
	}
	for name, want := range map[string]int{"forward": 3 + len(otherBridges) + 2, "input": 4} {
		chain, ok := chains[name]
		if !ok || chain.Hook != name || chain.Prio != -10 {
			return fmt.Errorf("chain %s is missing or hooked differently", name)
		}
		if rules[name] != want {
			return fmt.Errorf("chain %s has %d rules instead of %d", name, rules[name], want)
		}
	}
	if got := len(sets["private4"].Elem); got != len(PrivateIPv4) {
		return fmt.Errorf("set private4 has %d ranges instead of %d", got, len(PrivateIPv4))
	}
	if got := len(sets["private6"].Elem); got != len(PrivateIPv6) {
		return fmt.Errorf("set private6 has %d ranges instead of %d", got, len(PrivateIPv6))
	}
	want, err := sortedBridges(bridges)
	if err != nil {
		return err
	}
	restricted, err := setNames(sets["restricted"], false)
	if err != nil {
		return err
	}
	if !sameNames(restricted, want) {
		return fmt.Errorf("set restricted holds [%s] instead of [%s]", strings.Join(restricted, " "), strings.Join(want, " "))
	}
	intra, err := setNames(sets["intra"], true)
	if err != nil {
		return err
	}
	if !sameNames(intra, want) {
		return fmt.Errorf("set intra holds [%s] instead of [%s]", strings.Join(intra, " "), strings.Join(want, " "))
	}
	return nil
}

// setNames reads an ifname set's elements, or an `ifname . ifname` set's when pairs is set (only `a . a` pairs are
// expected; anything else is reported as `a.b`).
func setNames(set nftSet, pairs bool) ([]string, error) {
	names := make([]string, 0, len(set.Elem))
	for _, raw := range set.Elem {
		if !pairs {
			var name string
			if err := json.Unmarshal(raw, &name); err != nil {
				return nil, fmt.Errorf("set %s has an element that is not an interface name: %s", set.Name, raw)
			}
			names = append(names, name)
			continue
		}
		var pair struct {
			Concat []string `json:"concat"`
		}
		if err := json.Unmarshal(raw, &pair); err != nil || len(pair.Concat) != 2 {
			return nil, fmt.Errorf("set %s has an element that is not an interface pair: %s", set.Name, raw)
		}
		name := pair.Concat[0]
		if pair.Concat[1] != name {
			name += "." + pair.Concat[1]
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}

func sameNames(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
