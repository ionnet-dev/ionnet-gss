// Package egress keeps game servers away from private networks: one nftables table (TableName, family inet) that
// the agent owns completely, with the bridge interfaces of restricted servers in a named set. Docker's tables and
// the operator's own rules are never read, flushed or reordered; the table only ever adds drops on top of them.
package egress

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// TableName is the agent's nftables table (family inet).
const TableName = "ionnet_gss"

// Priority of the table's base chains: before Docker's filter rules (iptables-nft's FORWARD and INPUT run at
// priority filter = 0). An accept here doesn't skip Docker's chains; only a reject is final.
const chainPriority = "filter - 10"

// Destinations a restricted server may not open connections to. 240.0.0.0/4 also covers 255.255.255.255.
var (
	PrivateIPv4 = []string{
		"0.0.0.0/8",      // "this network"
		"10.0.0.0/8",     // RFC 1918
		"100.64.0.0/10",  // carrier-grade NAT, Tailscale
		"127.0.0.0/8",    // loopback (reached through a route_localnet or DNAT trick)
		"169.254.0.0/16", // link-local, cloud metadata (169.254.169.254)
		"172.16.0.0/12",  // RFC 1918, Docker's default bridge pools
		"192.168.0.0/16", // RFC 1918
		"224.0.0.0/4",    // multicast
		"240.0.0.0/4",    // reserved and limited broadcast
	}
	PrivateIPv6 = []string{
		"::/128",        // unspecified
		"::1/128",       // loopback
		"::ffff:0:0/96", // IPv4-mapped
		"fc00::/7",      // unique local
		"fe80::/10",     // link-local
		"fec0::/10",     // deprecated site-local
		"ff00::/8",      // multicast
	}
)

// otherBridges are host interfaces of other Docker networks: Docker's default bridge and every server bridge the
// agent names. Traffic from a restricted bridge out through them is refused whatever its address, in case Docker's
// address pools were moved outside the private ranges. Docker's own `br-<id>` names are left to the address check:
// a wildcard on them would also match an uplink bridge such as `br-lan`.
var otherBridges = []string{"docker0", "gss-*"}

// interfaceName is what a Linux interface name may look like here: 1-15 characters (IFNAMSIZ - 1) without quotes,
// spaces or the `*` wildcard.
var interfaceName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$`)

// ValidBridge reports whether name can go into the ruleset as an interface name.
func ValidBridge(name string) error {
	if !interfaceName.MatchString(name) {
		return fmt.Errorf("%q is not a bridge interface name the agent can filter (1-15 letters, digits, `_`, `.` or `-`)", name)
	}
	return nil
}

// Ruleset is the nft script that replaces the whole table atomically (one `nft -f` transaction): created empty if
// missing, deleted, then defined again with these restricted bridges. Every name is validated first, so nothing but
// agent-generated interface names reaches the script.
func Ruleset(table string, bridges []string) (string, error) {
	if err := ValidBridge(table); err != nil {
		return "", fmt.Errorf("table name: %w", err)
	}
	names, err := sortedBridges(bridges)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "add table inet %s\ndelete table inet %s\n\n", table, table)
	fmt.Fprintf(&b, "table inet %s {\n", table)
	b.WriteString("\tcomment \"gss-agent egress filtering for game servers; rebuilt by the agent, do not edit\"\n\n")

	b.WriteString("\tset restricted {\n\t\ttype ifname\n")
	if len(names) > 0 {
		fmt.Fprintf(&b, "\t\telements = { %s }\n", joinQuoted(names, func(name string) string { return quote(name) }))
	}
	b.WriteString("\t}\n\n")
	b.WriteString("\tset intra {\n\t\ttype ifname . ifname\n")
	if len(names) > 0 {
		fmt.Fprintf(&b, "\t\telements = { %s }\n", joinQuoted(names, func(name string) string { return quote(name) + " . " + quote(name) }))
	}
	b.WriteString("\t}\n\n")
	fmt.Fprintf(&b, "\tset private4 {\n\t\ttype ipv4_addr\n\t\tflags interval\n\t\telements = { %s }\n\t}\n\n", strings.Join(PrivateIPv4, ", "))
	fmt.Fprintf(&b, "\tset private6 {\n\t\ttype ipv6_addr\n\t\tflags interval\n\t\telements = { %s }\n\t}\n\n", strings.Join(PrivateIPv6, ", "))

	// Routed traffic: replies (players on a LAN who came in through a published port) and the server's own bridge
	// (game ↔ its stack's database) pass; then other Docker bridges and private destinations are refused.
	fmt.Fprintf(&b, "\tchain forward {\n\t\ttype filter hook forward priority %s; policy accept;\n", chainPriority)
	b.WriteString("\t\tct state established,related accept\n")
	b.WriteString("\t\tiifname != @restricted accept\n")
	b.WriteString("\t\tiifname . oifname @intra accept\n")
	for _, pattern := range otherBridges {
		fmt.Fprintf(&b, "\t\toifname %s counter reject with icmpx admin-prohibited\n", quote(pattern))
	}
	b.WriteString("\t\tip daddr @private4 counter reject with icmpx admin-prohibited\n")
	b.WriteString("\t\tip6 daddr @private6 counter reject with icmpx admin-prohibited\n")
	b.WriteString("\t}\n\n")

	// Traffic to the host itself (the bridge gateway, the LAN or public address, any local service): only replies
	// and IPv6 neighbour discovery. Docker's embedded DNS (127.0.0.11) lives in the container's own namespace.
	fmt.Fprintf(&b, "\tchain input {\n\t\ttype filter hook input priority %s; policy accept;\n", chainPriority)
	b.WriteString("\t\tiifname != @restricted accept\n")
	b.WriteString("\t\tct state established,related accept\n")
	b.WriteString("\t\ticmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit } accept\n")
	b.WriteString("\t\tcounter reject with icmpx admin-prohibited\n")
	b.WriteString("\t}\n}\n")
	return b.String(), nil
}

// AddScript adds bridges to the restricted sets of an existing table; it fails (and the caller rebuilds) when the
// table is missing. Adding an element that is already there is not an error.
func AddScript(table string, bridges []string) (string, error) {
	if err := ValidBridge(table); err != nil {
		return "", fmt.Errorf("table name: %w", err)
	}
	names, err := sortedBridges(bridges)
	if err != nil {
		return "", err
	}
	if len(names) == 0 {
		return "", fmt.Errorf("no bridges to add")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "add element inet %s restricted { %s }\n", table, joinQuoted(names, func(name string) string { return quote(name) }))
	fmt.Fprintf(&b, "add element inet %s intra { %s }\n", table, joinQuoted(names, func(name string) string { return quote(name) + " . " + quote(name) }))
	return b.String(), nil
}

// sortedBridges validates, dedupes and sorts bridge names so equal inputs give equal scripts.
func sortedBridges(bridges []string) ([]string, error) {
	seen := map[string]bool{}
	names := make([]string, 0, len(bridges))
	for _, name := range bridges {
		if err := ValidBridge(name); err != nil {
			return nil, err
		}
		if !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names, nil
}

func quote(name string) string { return `"` + name + `"` }

func joinQuoted(names []string, element func(string) string) string {
	parts := make([]string, len(names))
	for i, name := range names {
		parts[i] = element(name)
	}
	return strings.Join(parts, ", ")
}
