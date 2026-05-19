// ripperdoc-db-cli — admin tool for ripperdoc-devicedb.
//
// Speaks to the canonical SQLite file directly (no HTTP). Useful for
// review-queue work without spinning up curl.
//
// Subcommands:
//
//	queue list [--status S] [--limit N] [--order oldest_first|newest_first]
//	queue show <uuid>
//	accept <uuid>
//	reject <uuid> --reason ...
//	block <contributor_uuid> --reason ...
//	token issue --user-uuid U --name N --scopes contributions:moderate[,scope2]
//	user register --handle H [--email E]
//	snapshot regenerate
//
// All commands honour DATA_DIR (default ./data) to locate the DB.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"ripperdoc.de/devicedb/internal/snapshot"
	"ripperdoc.de/devicedb/internal/store"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("")

	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	dataDir := envOr("DATA_DIR", "./data")
	dbPath := filepath.Join(dataDir, "devicedb.sqlite")
	st, err := store.Open(dbPath)
	if err != nil {
		log.Fatalf("open store at %s: %v", dbPath, err)
	}
	defer st.Close()

	cmd := os.Args[1]
	args := os.Args[2:]

	switch cmd {
	case "queue":
		if len(args) < 1 {
			fmt.Fprintln(os.Stderr, "usage: queue list|show ...")
			os.Exit(2)
		}
		switch args[0] {
		case "list":
			queueList(st, args[1:])
		case "show":
			queueShow(st, args[1:])
		default:
			fmt.Fprintln(os.Stderr, "unknown queue subcommand:", args[0])
			os.Exit(2)
		}
	case "accept":
		accept(st, args)
	case "reject":
		reject(st, args)
	case "block":
		block(st, args)
	case "token":
		if len(args) < 1 {
			fmt.Fprintln(os.Stderr, "usage: token issue ...")
			os.Exit(2)
		}
		switch args[0] {
		case "issue":
			tokenIssue(st, args[1:])
		default:
			fmt.Fprintln(os.Stderr, "unknown token subcommand:", args[0])
			os.Exit(2)
		}
	case "user":
		if len(args) < 1 {
			fmt.Fprintln(os.Stderr, "usage: user register ...")
			os.Exit(2)
		}
		switch args[0] {
		case "register":
			userRegister(st, args[1:])
		default:
			fmt.Fprintln(os.Stderr, "unknown user subcommand:", args[0])
			os.Exit(2)
		}
	case "snapshot":
		if len(args) < 1 {
			fmt.Fprintln(os.Stderr, "usage: snapshot regenerate")
			os.Exit(2)
		}
		switch args[0] {
		case "regenerate":
			snapshotRegen(st, dataDir)
		default:
			fmt.Fprintln(os.Stderr, "unknown snapshot subcommand:", args[0])
			os.Exit(2)
		}
	case "help", "-h", "--help":
		usage()
	default:
		fmt.Fprintln(os.Stderr, "unknown command:", cmd)
		usage()
		os.Exit(2)
	}
}

func queueList(st *store.Store, args []string) {
	fs := flag.NewFlagSet("queue list", flag.ExitOnError)
	status := fs.String("status", "submitted", "filter by status")
	limit := fs.Int("limit", 50, "max rows")
	order := fs.String("order", "oldest_first", "oldest_first|newest_first")
	_ = fs.Parse(args)
	rows, err := st.Queue(*status, *order, *limit)
	if err != nil {
		log.Fatalf("queue: %v", err)
	}
	if len(rows) == 0 {
		fmt.Println("(empty)")
		return
	}
	for _, c := range rows {
		valTo := ""
		if c.ValueTo != nil {
			valTo = *c.ValueTo
		}
		fmt.Printf("%s  %s.%s  →  %q  (by %s, %s)\n",
			c.UUID, c.TargetType, c.TargetField, valTo, c.ContributorUUID, c.SubmittedAt)
	}
}

func queueShow(st *store.Store, args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: queue show <uuid>")
		os.Exit(2)
	}
	c, err := st.ContributionByUUID(args[0])
	if err != nil {
		log.Fatalf("not found: %v", err)
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	fmt.Println(string(b))
}

func accept(st *store.Store, args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: accept <uuid> [--reviewer-uuid U]")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("accept", flag.ExitOnError)
	reviewer := fs.String("reviewer-uuid", "", "reviewer contributor UUID (default: <cli-local>)")
	_ = fs.Parse(args[1:])
	rev := *reviewer
	if rev == "" {
		rev = ensureCliReviewer(st)
	}
	newStatus, err := st.Accept(args[0], rev)
	if err != nil {
		log.Fatalf("accept: %v", err)
	}
	fmt.Printf("%s → %s\n", args[0], newStatus)
}

func reject(st *store.Store, args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: reject <uuid> --reason ...")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("reject", flag.ExitOnError)
	reason := fs.String("reason", "", "rejection reason")
	reviewer := fs.String("reviewer-uuid", "", "reviewer contributor UUID")
	_ = fs.Parse(args[1:])
	if *reason == "" {
		log.Fatalf("--reason is required")
	}
	rev := *reviewer
	if rev == "" {
		rev = ensureCliReviewer(st)
	}
	if err := st.Reject(args[0], rev, *reason); err != nil {
		log.Fatalf("reject: %v", err)
	}
	fmt.Printf("%s → rejected\n", args[0])
}

func block(st *store.Store, args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: block <contributor_uuid> --reason ...")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("block", flag.ExitOnError)
	reason := fs.String("reason", "", "block reason")
	_ = fs.Parse(args[1:])
	if err := st.BlockContributor(args[0], *reason); err != nil {
		log.Fatalf("block: %v", err)
	}
	fmt.Printf("%s → blocked\n", args[0])
}

func tokenIssue(st *store.Store, args []string) {
	fs := flag.NewFlagSet("token issue", flag.ExitOnError)
	userUUID := fs.String("user-uuid", "", "contributor UUID (must be kind=user)")
	name := fs.String("name", "", "token label")
	scopes := fs.String("scopes", "contributions:submit", "comma-separated scopes")
	_ = fs.Parse(args)
	if *userUUID == "" || *name == "" {
		log.Fatalf("--user-uuid and --name required")
	}
	scopeList := splitCSV(*scopes)
	plain, err := st.IssueUserToken(*userUUID, *name, scopeList)
	if err != nil {
		log.Fatalf("issue token: %v", err)
	}
	fmt.Println(plain)
	fmt.Fprintln(os.Stderr, "(token printed once; keep it safe)")
}

func userRegister(st *store.Store, args []string) {
	fs := flag.NewFlagSet("user register", flag.ExitOnError)
	handle := fs.String("handle", "", "display handle")
	email := fs.String("email", "", "email (optional)")
	_ = fs.Parse(args)
	if *handle == "" {
		log.Fatalf("--handle required")
	}
	cu, token, err := st.RegisterUser(*handle, *email)
	if err != nil {
		log.Fatalf("user register: %v", err)
	}
	fmt.Printf("user_uuid=%s\ntoken=%s\n", cu, token)
}

func snapshotRegen(st *store.Store, dataDir string) {
	snapDir := filepath.Join(dataDir, "snapshots")
	keyPath := os.Getenv("SNAPSHOT_PRIVATE_KEY_PATH")
	mgr, err := snapshot.NewManager(st, snapDir, envOr("SNAPSHOT_TARBALL_BASE_URL", "http://localhost:8090/v1/snapshots"), keyPath)
	if err != nil {
		log.Fatalf("snapshot manager: %v", err)
	}
	man, err := mgr.Regenerate()
	if err != nil {
		log.Fatalf("regenerate: %v", err)
	}
	b, _ := json.MarshalIndent(man, "", "  ")
	fmt.Println(string(b))
}

// ensureCliReviewer returns a stable "cli-local" reviewer contributor UUID.
// If none exists, creates a kind='user' row with handle 'cli-local' so the
// audit log carries a real foreign-key target.
func ensureCliReviewer(st *store.Store) string {
	var existing string
	err := st.DB.QueryRow("SELECT uuid FROM contributors WHERE kind='user' AND handle='cli-local' LIMIT 1").Scan(&existing)
	if err == nil && existing != "" {
		return existing
	}
	id := uuid.NewString()
	_, _ = st.DB.Exec("INSERT INTO contributors (uuid, kind, handle, created_at, last_seen) VALUES (?, 'user', 'cli-local', ?, ?)",
		id, nowUTC(), nowUTC())
	return id
}

func nowUTC() string { return time.Now().UTC().Format(time.RFC3339) }

func usage() {
	fmt.Fprintln(os.Stderr, `ripperdoc-db-cli — admin tool

USAGE:
  ripperdoc-db-cli queue list [--status S] [--limit N] [--order oldest_first|newest_first]
  ripperdoc-db-cli queue show <uuid>
  ripperdoc-db-cli accept <uuid>
  ripperdoc-db-cli reject <uuid> --reason ...
  ripperdoc-db-cli block  <contributor_uuid> --reason ...
  ripperdoc-db-cli token  issue --user-uuid U --name N --scopes contributions:moderate
  ripperdoc-db-cli user   register --handle H [--email E]
  ripperdoc-db-cli snapshot regenerate

ENV:
  DATA_DIR                    canonical DB directory (default ./data)
  SNAPSHOT_PRIVATE_KEY_PATH   Ed25519 private key for snapshot manifests
  SNAPSHOT_TARBALL_BASE_URL   public URL prefix for tarballs in manifest`)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func splitCSV(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
